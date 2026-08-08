#include <sourcemod>

#pragma semicolon 1
#pragma newdecls required

// An empty L4D2 server should idle cheaply, but ZoneMod sets fleet-wide `fps_max 0`
// (uncapped) and after a match the leftover bot/Director state can stop the engine from
// hibernating, so the empty box spins its main loop at 900+ fps (~20% of a core). Forcing
// hibernation via a map reload would fix that, but on a ZoneMod server a `changelevel`
// triggers confogl's pred_unload, which churns every plugin (and breaks !match). So instead
// this plugin just CAPS fps_max while the server is empty — cheap, no side effects — and
// restores `fps_max 0` the instant a human joins, so live matches are untouched.
//
// (Filename kept as idle_hibernate for continuity; it no longer reloads the map.)

#define EMPTY_DELAY 15.0   // seconds to wait after the last human leaves
#define IDLE_FPS    30     // fps cap while empty (vs ZoneMod's uncapped fps_max 0)

ConVar g_cvFpsMax;
Handle g_hTimer = null;

public Plugin myinfo =
{
    name        = "Idle FPS Cap",
    author      = "Luciano Giraldo",
    description = "Caps fps_max while the server is empty so it doesn't spin at fps_max 0 after a match.",
    version     = "2.0.0",
    url         = ""
};

public void OnPluginStart()
{
    g_cvFpsMax = FindConVar("fps_max");

    // If we load onto an already-empty server, cap right away.
    if (g_cvFpsMax != null && HumanCount() == 0)
        g_cvFpsMax.IntValue = IDLE_FPS;
}

public void OnClientPutInServer(int client)
{
    if (client < 1 || IsFakeClient(client))
        return;

    // A human is here — cancel any pending cap and uncap for play (ZoneMod wants fps_max 0).
    delete g_hTimer;
    g_hTimer = null;
    if (g_cvFpsMax != null)
        g_cvFpsMax.IntValue = 0;
}

public void OnClientDisconnect(int client)
{
    // Ignore bots; only a human leaving can schedule the empty check.
    if (IsFakeClient(client))
        return;

    delete g_hTimer;
    g_hTimer = CreateTimer(EMPTY_DELAY, Timer_CapIdle);
}

public Action Timer_CapIdle(Handle timer)
{
    g_hTimer = null;

    if (HumanCount() > 0)
        return Plugin_Stop; // someone is (still) here

    if (g_cvFpsMax != null)
        g_cvFpsMax.IntValue = IDLE_FPS;

    return Plugin_Stop;
}

int HumanCount()
{
    int n = 0;
    for (int i = 1; i <= MaxClients; i++)
        if (IsClientInGame(i) && !IsFakeClient(i))
            n++;
    return n;
}
