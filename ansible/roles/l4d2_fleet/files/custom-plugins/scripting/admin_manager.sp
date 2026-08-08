#include <sourcemod>

#pragma semicolon 1
#pragma newdecls required

#define ADMINS_FILE "configs/admins_simple.ini"
#define TAG "\x04[Admin]\x01"

public Plugin myinfo =
{
    name        = "Admin Manager",
    author      = "Luciano Giraldo",
    description = "Gestion de admins in-game: !admin add/delete/list/help",
    version     = "2.0.0",
    url         = ""
};

public void OnPluginStart()
{
    // Interceptamos sm_admin (el menu de SourceMod) para agregar subcomandos
    AddCommandListener(OnSmAdmin, "sm_admin");
}

public Action OnSmAdmin(int client, const char[] command, int argc)
{
    if (argc < 1)
        return Plugin_Continue; // "!admin" solo -> menu normal de SourceMod

    char sub[16];
    GetCmdArg(1, sub, sizeof(sub));

    bool isAdd  = StrEqual(sub, "add", false)    || StrEqual(sub, "agregar", false);
    bool isDel  = StrEqual(sub, "delete", false) || StrEqual(sub, "del", false) || StrEqual(sub, "remove", false) || StrEqual(sub, "quitar", false);
    bool isList = StrEqual(sub, "list", false)   || StrEqual(sub, "lista", false) || StrEqual(sub, "ls", false);
    bool isHelp = StrEqual(sub, "help", false)   || StrEqual(sub, "ayuda", false) || StrEqual(sub, "?", false);

    if (!isAdd && !isDel && !isList && !isHelp)
        return Plugin_Continue; // no es subcomando nuestro -> dejar pasar al menu

    if (!IsRoot(client))
    {
        ReplyToCommand(client, "%s Necesitas ser admin \x03ROOT\x01 (flag z) para gestionar admins.", TAG);
        return Plugin_Handled;
    }

    if (isHelp)      ShowHelp(client);
    else if (isList) DoList(client);
    else if (isAdd)  DoAdd(client);
    else if (isDel)  DoDelete(client);

    return Plugin_Handled;
}

bool IsRoot(int client)
{
    if (client == 0) return true; // consola / RCON = root
    AdminId aid = GetUserAdmin(client);
    if (aid == INVALID_ADMIN_ID) return false;
    return GetAdminFlag(aid, Admin_Root);
}

void GetAdminsPath(char[] path, int maxlen)
{
    BuildPath(Path_SM, path, maxlen, ADMINS_FILE);
}

// Devuelve en 'rest' todo lo que va despues del primer token (el subcomando)
void GetAfterSub(char[] rest, int maxlen)
{
    char argstr[300], sub[16];
    GetCmdArgString(argstr, sizeof(argstr));
    TrimString(argstr);
    int after = BreakString(argstr, sub, sizeof(sub));
    if (after == -1) rest[0] = '\0';
    else strcopy(rest, maxlen, argstr[after]);
    TrimString(rest);
}

bool LooksLikeSteamId(const char[] s)
{
    if (strncmp(s, "STEAM_", 6, false) == 0) return true; // Steam2
    if (s[0] == '[') return true;                          // Steam3 [U:1:...]
    if (s[0] == '!') return true;                          // IP (!1.2.3.4)
    // SteamID64: solo digitos y largo >= 15
    int len = strlen(s);
    if (len >= 15)
    {
        for (int i = 0; i < len; i++)
            if (!IsCharNumeric(s[i])) return false;
        return true;
    }
    return false;
}

void ShowHelp(int client)
{
    ReplyToCommand(client, "%s ===== Gestion de Admins =====", TAG);
    ReplyToCommand(client, "%s !admin add <SteamID> <flags> [nombre]  - agrega un admin", TAG);
    ReplyToCommand(client, "%s !admin delete <SteamID>                - quita un admin", TAG);
    ReplyToCommand(client, "%s !admin list                           - lista los admins", TAG);
    ReplyToCommand(client, "%s !admin help                           - muestra esta ayuda", TAG);
    ReplyToCommand(client, "%s Flags: z=root  c=kick  d=ban  e=unban  f=slay  g=mapa  j=chat  m=rcon", TAG);
    ReplyToCommand(client, "%s Inmunidad opcional: usa 99:z  (mayor numero = mas inmune)", TAG);
    ReplyToCommand(client, "%s Ej: !admin add STEAM_1:0:12345678 z Pepe", TAG);
    ReplyToCommand(client, "%s SteamID de un jugador conectado: !who", TAG);
}

void UsageAdd(int client)
{
    ReplyToCommand(client, "%s Uso: \x03!admin add <SteamID> <flags> [nombre]\x01", TAG);
    ReplyToCommand(client, "%s Ej:  !admin add STEAM_1:0:12345678 z Pepe", TAG);
}

void UsageDel(int client)
{
    ReplyToCommand(client, "%s Uso: \x03!admin delete <SteamID>\x01", TAG);
    ReplyToCommand(client, "%s Ej:  !admin delete STEAM_1:0:12345678", TAG);
}

void DoAdd(int client)
{
    char rest[300];
    GetAfterSub(rest, sizeof(rest));
    if (rest[0] == '\0') { UsageAdd(client); return; }

    char sid[64], flags[32], name[128], rem[300];
    int p = BreakString(rest, sid, sizeof(sid));
    if (p == -1) { ReplyToCommand(client, "%s Falta <flags>.", TAG); UsageAdd(client); return; }
    strcopy(rem, sizeof(rem), rest[p]);
    int p2 = BreakString(rem, flags, sizeof(flags));
    if (flags[0] == '\0') { ReplyToCommand(client, "%s Falta <flags>.", TAG); UsageAdd(client); return; }
    if (p2 != -1) { strcopy(name, sizeof(name), rem[p2]); TrimString(name); }
    else name[0] = '\0';

    if (!LooksLikeSteamId(sid))
    {
        ReplyToCommand(client, "%s '\x03%s\x01' no parece un SteamID valido (ej: STEAM_1:0:12345678).", TAG, sid);
        return;
    }

    char path[PLATFORM_MAX_PATH];
    GetAdminsPath(path, sizeof(path));
    File f = OpenFile(path, "a");
    if (f == null) { ReplyToCommand(client, "%s Error: no pude abrir el archivo de admins.", TAG); return; }

    if (name[0] != '\0') f.WriteLine("\"%s\" \"%s\" // %s", sid, flags, name);
    else                 f.WriteLine("\"%s\" \"%s\"", sid, flags);
    delete f;

    ServerCommand("sm_reloadadmins");
    ReplyToCommand(client, "%s Admin agregado: \x03%s\x01 (flags: %s)%s%s. Cache recargado.", TAG, sid, flags, name[0] != '\0' ? " - " : "", name);
    LogAction(client, -1, "\"%L\" agrego admin %s con flags %s", client, sid, flags);
}

void DoDelete(int client)
{
    char rest[300], sid[64];
    GetAfterSub(rest, sizeof(rest));
    if (rest[0] == '\0') { UsageDel(client); return; }
    BreakString(rest, sid, sizeof(sid));
    if (sid[0] == '\0') { UsageDel(client); return; }

    char path[PLATFORM_MAX_PATH], tmp[PLATFORM_MAX_PATH];
    GetAdminsPath(path, sizeof(path));
    Format(tmp, sizeof(tmp), "%s.tmp", path);

    File fin = OpenFile(path, "r");
    if (fin == null) { ReplyToCommand(client, "%s No pude leer el archivo de admins.", TAG); return; }
    File fout = OpenFile(tmp, "w");
    if (fout == null) { delete fin; ReplyToCommand(client, "%s No pude crear archivo temporal.", TAG); return; }

    char line[512];
    int removed = 0;
    while (fin.ReadLine(line, sizeof(line)))
    {
        if (StrContains(line, sid, false) != -1) { removed++; continue; }
        fout.WriteString(line, false);
    }
    delete fin;
    delete fout;

    if (removed == 0)
    {
        DeleteFile(tmp);
        ReplyToCommand(client, "%s No encontre ningun admin que coincida con \x03%s\x01.", TAG, sid);
        return;
    }

    DeleteFile(path);
    RenameFile(path, tmp);
    ServerCommand("sm_reloadadmins");
    ReplyToCommand(client, "%s Quitado(s) \x03%d\x01 admin(s) con \x03%s\x01. Cache recargado.", TAG, removed, sid);
    LogAction(client, -1, "\"%L\" quito admin %s (%d lineas)", client, sid, removed);
}

void DoList(int client)
{
    char path[PLATFORM_MAX_PATH];
    GetAdminsPath(path, sizeof(path));
    File fin = OpenFile(path, "r");
    if (fin == null) { ReplyToCommand(client, "%s No pude leer el archivo de admins.", TAG); return; }

    ReplyToCommand(client, "%s ===== Admins registrados =====", TAG);
    char line[512];
    int n = 0;
    while (fin.ReadLine(line, sizeof(line)))
    {
        TrimString(line);
        if (line[0] == '\0') continue;
        if (line[0] == '/' && line[1] == '/') continue;
        ReplyToCommand(client, "  %s", line);
        n++;
    }
    delete fin;
    ReplyToCommand(client, "%s Total: \x03%d\x01", TAG, n);
}
