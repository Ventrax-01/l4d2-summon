# Panel L4D2 — web

Frontend de la plataforma para reservar servidores bajo demanda. React + Vite + TypeScript,
CSS plano con los tokens del diseño. Sin librerías de UI ni de estado.

## Arrancar

```bash
npm install
npm run dev        # http://localhost:5173
```

Arranca en **modo mock**: la aplicación funciona entera sin backend ni la PC encendida.

## Modo mock y escenarios

El botón **demo** (abajo a la derecha) abre el panel de escenarios. Permite recorrer todos
los estados de la interfaz sin depender de nada:

| Escenario | Qué prueba |
|---|---|
| Servidores (1–8) | Que la rejilla aguante cualquier número; el tope lo decide el operador |
| Sistema dormido / despierto | Las dos duraciones del stepper (~3 min con encendido, ~45 s sin él) |
| Todos ocupados | La cola: posición, promoción y cuenta atrás del turno |
| Falla la preparación | El error del stepper con reintento |
| Error al cargar la lista | Error de sección (el resto de la app sigue viva) |
| Servicio caído | La pantalla global de fallo |
| Falla el login | El error al entrar con Steam |
| Con sesión iniciada | Quitarlo muestra la home pública tal como la ve un visitante |
| Velocidad ×1 / ×5 / ×20 | Comprime los tiempos reales para iterar sin esperar 3 minutos |

También se pueden fijar por URL: `?n=8`, `?host=up`, `?ocupados=1`, `?falla=1`, `?caido=1`,
`?anon=1`, `?vel=20`. Es lo que usan las pruebas.

Para apuntar al backend real: `VITE_API_MODE=http` (ver `.env.example`). Se puede volver al
mock en cualquier despliegue con `?mock=1`.

## Pruebas

```bash
npm test           # 60 pruebas, escritorio y móvil
npm run test:ui    # modo interactivo
```

Corren contra el modo mock, que es determinista, así que no necesitan nube ni servidor de
juego.

## Estructura

```
src/
├── api/           # frontera de datos: una interfaz, dos implementaciones
│   ├── tipos.ts   # el contrato que consume toda la UI
│   ├── mock/      # motor de simulación + escenarios
│   └── http.ts    # contra el backend real (aún sin desplegar)
├── context/       # FlotaContext: el único poller de la app
├── components/    # slot, flujo, layout, ui, demo
├── screens/       # una por ruta
├── styles/        # tokens del diseño + base
├── types/         # tipos del contrato con el backend
└── lib/           # formato y utilidades
```

## Decisiones que conviene conocer

**Ningún componente llama a `fetch`.** Todo pasa por `clienteApi`, así que cambiar de mock a
backend real es una variable de entorno y no un refactor.

**Un solo poller en toda la aplicación**, en `FlotaContext`, con cadencia adaptativa: 15 s en
reposo, 4 s con una reserva en curso, 20 s si ya estás jugando, y **pausa total con la pestaña
oculta**. Un intervalo fijo agresivo multiplicaría las invocaciones Lambda sin aportar nada;
esto está medido en el análisis de costos del diseño técnico.

**Los tokens del diseño están centralizados** en `styles/tokens.css`. El Board original usa
hex inline; aquí hay una sola fuente de verdad.

**El backend calcula el stepper** (`{total, current, labels}`), así que la UI no conoce los
estados internos de la máquina. Por eso las dos duraciones no generan ramas en el código.

**El número de servidores es dinámico.** Nunca se asume 4: viene de la configuración y la
rejilla se adapta.
