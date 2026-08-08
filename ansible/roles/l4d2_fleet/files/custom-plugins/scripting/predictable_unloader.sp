#pragma newdecls required
#include <sourcemod>

// Patched fork of SirPlease's "Predictable Plugin Unloader" v1.2.2 (shipped with ZoneMod).
// confogl runs `pred_unload_plugins` on every matchmode transition, which unloads EVERY
// loaded plugin and then `sm plugins refresh`es. The refresh races with confogl's plugin
// load-lock, so the fleet's own general-purpose plugins (chat_logger, admin_manager,
// idle_hibernate) don't reliably come back — they end up unloaded during/after matches.
// They're not competitive plugins and must stay loaded at all times, so this fork RESERVES
// them: they're skipped by the unloader and therefore never dropped. Everything else is
// unloaded exactly as before. (Re-introduces the per-plugin reservation the original had in
// v1.0 and removed in v1.2.)

// Fleet plugins that must survive matchmode plugin churn (filenames relative to plugins/).
char gKeep[][] =
{
    "chat_logger.smx",
    "admin_manager.smx",
    "idle_hibernate.smx"
};

Handle aReservedPlugins;
char sPlugin[PLATFORM_MAX_PATH];

public Plugin myinfo =
{
    name = "Predictable Plugin Unloader",
    author = "Sir (heavily influenced by keyCat); fleet reserve patch",
    version = "1.2.2-fleet",
    description = "Unloads plugins last-to-first, reserving the fleet's always-on plugins."
}

static bool ShouldKeep(const char[] filename)
{
    for (int i = 0; i < sizeof(gKeep); i++)
        if (StrEqual(filename, gKeep[i], false))
            return true;
    return false;
}

public void OnPluginStart()
{
    RegServerCmd("pred_unload_plugins", UnloadPlugins, "Unload Plugins!");
    GetPluginFilename(INVALID_HANDLE, sPlugin, sizeof(sPlugin));
    aReservedPlugins = CreateArray(PLATFORM_MAX_PATH);
}

Action UnloadPlugins(int args)
{
    char stockpluginname[64];
    Handle pluginIterator = GetPluginIterator();
    Handle currentPlugin;

    ClearArray(aReservedPlugins);

    while (MorePlugins(pluginIterator))
    {
        currentPlugin = ReadPlugin(pluginIterator);
        GetPluginFilename(currentPlugin, stockpluginname, sizeof(stockpluginname));

        // Skip ourself (unloaded on a timer at the end) and the reserved fleet plugins.
        if (!StrEqual(sPlugin, stockpluginname) && !ShouldKeep(stockpluginname))
            PushArrayString(aReservedPlugins, stockpluginname);
    }

    CloseHandle(currentPlugin);
    CloseHandle(pluginIterator);

    ServerCommand("sm plugins load_unlock");

    for (int iSize = GetArraySize(aReservedPlugins); iSize > 0; iSize--)
    {
        char sReserved[PLATFORM_MAX_PATH];
        GetArrayString(aReservedPlugins, iSize - 1, sReserved, sizeof(sReserved));
        ServerCommand("sm plugins unload %s", sReserved);
    }

    CreateTimer(0.1, RefreshPlugins);
    CreateTimer(0.5, UnloadSelf);

    return Plugin_Handled;
}

Action RefreshPlugins(Handle timer)
{
    ServerCommand("sm plugins refresh");
    return Plugin_Stop;
}

Action UnloadSelf(Handle timer)
{
    ServerCommand("sm plugins unload %s", sPlugin);
    return Plugin_Stop;
}
