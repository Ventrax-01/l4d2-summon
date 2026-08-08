#include <sourcemod>

#pragma semicolon 1
#pragma newdecls required

// Player chat is written to a dedicated per-server file
// (addons/sourcemod/logs/chat/chat-<port>.log) which Promtail tails into Loki for the
// Grafana chat panel. We write a file instead of PrintToServer because SourceMod console
// output does NOT reach the headless srcds stdout/journald on this engine build (Facepunch
// garrysmod-issues #2343). The path stays inside the game dir because SourceMod's OpenFile
// can only write there (absolute paths like /var/log silently fail); Promtail reads it by
// being a member of the server's group. Both the OnClientSayCommand_Post forward and a say
// command listener are hooked (different builds route player chat through one or the other),
// de-duplicated so a message logs exactly once. (Server/RCON `say` is not captured — the
// engine doesn't route console-origin say through either path.)

public Plugin myinfo =
{
    name        = "Chat Logger",
    author      = "Luciano Giraldo",
    description = "Writes player chat to a per-server log file for aggregation (Loki/Grafana).",
    version     = "2.2.0",
    url         = ""
};

int g_port;
char g_lastKey[320];

static void WriteChat(int client, const char[] command, const char[] rawmsg)
{
    // Only real players: server console / RCON say doesn't reach these hooks anyway.
    if (client < 1 || IsFakeClient(client))
        return;

    char msg[256];
    strcopy(msg, sizeof(msg), rawmsg);
    StripQuotes(msg);
    TrimString(msg);
    if (msg[0] == '\0')
        return;

    // De-dup: both hooks can fire for the same message in the same frame. Same
    // client + game time + text => log once.
    char key[320];
    Format(key, sizeof(key), "%d|%.2f|%s", client, GetGameTime(), msg);
    if (StrEqual(key, g_lastKey))
        return;
    strcopy(g_lastKey, sizeof(g_lastKey), key);

    if (g_port == 0)
    {
        ConVar cv = FindConVar("hostport");
        if (cv != null) g_port = cv.IntValue;
    }

    char name[MAX_NAME_LENGTH];
    GetClientName(client, name, sizeof(name));

    char path[PLATFORM_MAX_PATH];
    BuildPath(Path_SM, path, sizeof(path), "logs/chat/chat-%d.log", g_port);

    // Open/append/close per line: chat is low-volume, so this is cheap and avoids any
    // flush/buffering concern. Lead with the Unix epoch so Promtail stamps the real time.
    File fh = OpenFile(path, "a");
    if (fh != null)
    {
        fh.WriteLine("%d %s %s: %s", GetTime(), StrEqual(command, "say_team", false) ? "(team)" : "(all)", name, msg);
        delete fh;
    }
}

public void OnPluginStart()
{
    AddCommandListener(OnSayListener, "say");
    AddCommandListener(OnSayListener, "say_team");

    // Ensure the chat dir exists (Ansible also creates it). 493 == 0o755; SourcePawn has no
    // octal literals, so 0755 would be read as decimal 755 and yield broken permissions.
    char dir[PLATFORM_MAX_PATH];
    BuildPath(Path_SM, dir, sizeof(dir), "logs/chat");
    if (!DirExists(dir))
        CreateDirectory(dir, 493);
}

// Non-Post forward: fires for EVERY plugin even when another plugin (a chat reformatter,
// dead-chat handler, readyup, etc.) blocks the say with Plugin_Handled — the _Post version
// is skipped when the say is blocked, which is why regular chat went uncaptured while
// commands (which pass through) were logged. De-dup in WriteChat handles the overlap with
// the command listener below. Never block chat ourselves.
public Action OnClientSayCommand(int client, const char[] command, const char[] sArgs)
{
    WriteChat(client, command, sArgs);
    return Plugin_Continue;
}

public Action OnSayListener(int client, const char[] command, int argc)
{
    char msg[256];
    GetCmdArgString(msg, sizeof(msg));
    WriteChat(client, command, msg);
    return Plugin_Continue; // never block chat
}
