#include <sourcemod>

#pragma semicolon 1
#pragma newdecls required

/* Da el mando de ESTE servidor a quien lo reservó.
 *
 * Hace falta un plugin porque admins_simple.ini pertenece al install de SourceMod, que los
 * cuatro servidores comparten: un admin escrito ahí lo sería en toda la flota a la vez, y lo
 * que se quiere es justo lo contrario — que cada quien mande solo en el suyo.
 *
 * Aquí el permiso vive en memoria del proceso: nace cuando la nube lo pide por RCON y muere
 * con el servidor. No toca ningún fichero, así que no hay nada que limpiar después.
 *
 * Los permisos son deliberadamente cortos: echar a alguien, cambiar de mapa y votar. NO se
 * dan banear ni RCON. Un ban sobreviviría a la reserva y le caería al siguiente que use el
 * servidor, y quien reserva manda durante su rato, no sobre la flota.
 */

#define TAG "\x04[Summon]\x01"

char g_Duenio[32];   // SteamID64 de quien reservó, vacío si no hay nadie

public Plugin myinfo =
{
    name        = "Summon Admin",
    author      = "l4d2-summon",
    description = "Admin por servidor para quien lo reserva",
    version     = "1.0.0",
    url         = "https://l4d2.ventrax.dev"
};

public void OnPluginStart()
{
    RegServerCmd("sm_summon_admin", CmdDarMando, "Da el mando de este servidor a un SteamID64");
    RegServerCmd("sm_summon_clear", CmdQuitarMando, "Quita el mando concedido");
}

/* Se aplica aquí y no en OnClientAuthorized porque en este punto SourceMod ya resolvió su
 * caché de admins: si se hiciera antes, la caché la sobrescribiría justo después. */
public void OnClientPostAdminCheck(int client)
{
    AplicarSiEsElDuenio(client);
}

/* Y otra vez cada vez que la caché se reconstruye, porque una reconstrucción tira todos los
 * AdminId creados en memoria — incluido el nuestro. Sin esto el dueño pierde el mando en
 * mitad de su reserva, sin aviso y sin haber hecho nada.
 *
 * No es un caso raro: SourceBans reconstruye la caché al cargar sus propios admins desde la
 * base, y cualquier sm_reloadadmins hace lo mismo. Antes de instalar el panel esto no
 * pasaba nunca, y por eso el fallo estuvo escondido. */
public void OnRebuildAdminCache(AdminCachePart part)
{
    if (part != AdminCache_Admins) return;

    for (int i = 1; i <= MaxClients; i++)
        AplicarSiEsElDuenio(i);
}

void AplicarSiEsElDuenio(int client)
{
    if (g_Duenio[0] == '\0') return;
    if (client <= 0 || !IsClientInGame(client) || IsFakeClient(client)) return;

    char id[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
    if (!StrEqual(id, g_Duenio)) return;

    AdminId adm = CreateAdmin("summon");
    if (adm == INVALID_ADMIN_ID) return;

    SetAdminFlag(adm, Admin_Generic, true);    // acceso a los comandos de admin
    SetAdminFlag(adm, Admin_Kick, true);       // echar
    SetAdminFlag(adm, Admin_Changemap, true);  // cambiar de mapa / campaña
    SetAdminFlag(adm, Admin_Vote, true);       // forzar votaciones
    /* Admin_Chat queda fuera a propósito. Suena inofensivo —es el de sm_say y compañía—
     * pero es también el que SourceComms exige para gag, mute y silence, y esos tres se
     * guardan en la base de SourceBans y salen listados en el panel con nombre y apellido.
     * Un castigo que sobrevive a la reserva y aparece en el historial público no es algo
     * que deba poder poner quien alquiló el servidor durante una hora. */
    // Inmunidad media: por encima de los jugadores, por debajo del operador de la flota,
    // que conserva el root y puede intervenir si hace falta.
    SetAdminImmunityLevel(adm, 50);

    SetUserAdmin(client, adm, true);
    PrintToChat(client, "%s Este servidor es tuyo: puedes echar jugadores y cambiar de mapa.", TAG);
}

/* La nube lo llama por RCON en cuanto el servidor responde, y luego lo repite en cada vuelta
 * mientras dure la reserva. Esa repetición es deliberada: el dueño vive en memoria de este
 * plugin, así que cualquier recarga lo borra —y el paso a matchmode recarga TODOS los
 * plugins, que es justo lo que pasa cuando alguien escribe !match nada más entrar.
 *
 * Por eso una llamada con el mismo SteamID no hace nada y no imprime nada: si no, serían
 * cuatro líneas por minuto en la consola de cada servidor para no decir nada. Responde OK
 * igualmente porque el agente espera esa palabra para dar la reserva por lista. */
public Action CmdDarMando(int args)
{
    if (args < 1)
    {
        PrintToServer("ERROR falta el SteamID64");
        return Plugin_Handled;
    }

    char nuevo[32];
    GetCmdArg(1, nuevo, sizeof(nuevo));

    if (StrEqual(nuevo, g_Duenio))
    {
        PrintToServer("OK sin cambios");
        return Plugin_Handled;
    }

    strcopy(g_Duenio, sizeof(g_Duenio), nuevo);

    // Puede que ya esté dentro esperando: se le da el mando ahora mismo.
    for (int i = 1; i <= MaxClients; i++)
        AplicarSiEsElDuenio(i);

    PrintToServer("OK admin de summon fijado en %s", g_Duenio);
    return Plugin_Handled;
}

public Action CmdQuitarMando(int args)
{
    g_Duenio[0] = '\0';
    PrintToServer("OK admin de summon retirado");
    return Plugin_Handled;
}
