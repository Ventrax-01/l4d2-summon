import { defineConfig, devices } from '@playwright/test'

/* Las pruebas corren contra el modo mock, que es determinista: el escenario se fija por
   query param en cada test, así que no dependen de nube ni de la PC encendida.

   Se prueban dos viewports porque el producto es mobile-first y varias reglas de layout
   solo existen en móvil. */

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    // El motor de mocks avanza con el reloj; los tests esperan a que la UI reaccione.
    actionTimeout: 10_000,
  },

  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] } },
    { name: 'movil', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
