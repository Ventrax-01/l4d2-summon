/* Estados no felices y pantallas de cuenta. Se prueban con el mismo cariño que el
   camino feliz porque son los que más se ven cuando algo va mal. */

import { expect, test } from '@playwright/test'

const ESPERA_ENTREGA = 30_000

test.describe('Errores', () => {
  test('si el servicio no responde, se muestra la pantalla global', async ({ page }) => {
    await page.goto('/?caido=1')

    await expect(page.getByRole('heading', { name: 'Estamos fuera de línea' })).toBeVisible()
    await expect(page.getByText(/No es tu conexión/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible()
  })

  test('el panel de escenarios sigue accesible con el servicio caído', async ({ page }) => {
    // Si no, activar ese escenario dejaría la demo sin forma de salir.
    await page.goto('/?caido=1')
    await expect(page.getByRole('button', { name: 'demo' })).toBeVisible()
  })

  test('si falla la lista, el error es de sección y se puede reintentar', async ({ page }) => {
    await page.goto('/?anon=1')
    await page.evaluate(() => {
      const clave = 'l4d2panel.escenario'
      const actual = JSON.parse(localStorage.getItem(clave) ?? '{}')
      localStorage.setItem(clave, JSON.stringify({ ...actual, errorDeLista: true }))
    })
    await page.reload()

    await expect(page.getByRole('alert')).toContainText('La lista no cargó')
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible()
  })
})

test.describe('Mi servidor', () => {
  test('sin reserva muestra el vacío con CTA', async ({ page }) => {
    await page.goto('/mi-servidor?host=up&n=2')

    await expect(page.getByRole('heading', { name: 'No tienes servidor ahora' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Reservar servidor/ })).toBeVisible()
    await expect(page.getByText(/1 servidor por persona/)).toBeVisible()
  })

  test('con reserva muestra el servidor y permite cerrarlo con confirmación', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: ESPERA_ENTREGA,
    })

    await page.getByRole('button', { name: 'Ir a Mi servidor' }).click()
    await expect(page.getByRole('heading', { name: 'Mi servidor' })).toBeVisible()

    // Cerrar avisa del impacto antes de hacerlo.
    await page.getByRole('button', { name: 'Cerrar servidor' }).click()
    const dialogo = page.getByRole('dialog')
    await expect(dialogo).toContainText('¿Cerrar tu servidor?')
    await expect(dialogo.getByRole('button', { name: /Sí, cerrar servidor/ })).toBeVisible()

    // Se puede desistir.
    await dialogo.getByRole('button', { name: /No, seguir jugando/ }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('muestra la imagen del mapa', async ({ page }) => {
    // Se olvidó conectarla aquí cuando se añadieron las miniaturas a las tarjetas.
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: ESPERA_ENTREGA,
    })
    await page.getByRole('button', { name: 'Ir a Mi servidor' }).click()

    const fondo = await page.locator('.mis-mapa').evaluate(
      (el) => getComputedStyle(el).backgroundImage,
    )
    expect(fondo).toContain('/mapas/')
  })

  test('cerrar de verdad libera el servidor', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: ESPERA_ENTREGA,
    })

    await page.getByRole('button', { name: 'Ir a Mi servidor' }).click()
    await page.getByRole('button', { name: 'Cerrar servidor' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Sí, cerrar servidor/ }).click()

    await expect(page).toHaveURL(/\/$|\/\?/)
    await expect(page.getByRole('heading', { name: 'Reserva y juega en minutos' })).toBeVisible()
  })
})

test.describe('Perfil', () => {
  test('muestra los datos de Steam como solo lectura', async ({ page }) => {
    await page.goto('/perfil?host=up&n=2')

    await expect(page.getByText('SOLO LECTURA')).toBeVisible()
    await expect(page.getByText(/STEAM64 · \d+/)).toBeVisible()
    await expect(page.getByText(/aquí no hay nada que configurar/)).toBeVisible()
  })

  test('cerrar sesión saca de la zona privada', async ({ page }) => {
    await page.goto('/perfil?host=up&n=2')

    await page.getByRole('button', { name: 'Cerrar sesión' }).click()

    // El perfil es ruta privada: al perder la sesión, el guard lleva al login.
    await expect(page).toHaveURL(/\/entrar/)
    await expect(page.getByRole('button', { name: 'Entrar con Steam' })).toBeVisible()
  })
})

test.describe('Rutas privadas', () => {
  test('sin sesión, mi-servidor redirige al login', async ({ page }) => {
    await page.goto('/mi-servidor?anon=1')

    await expect(page).toHaveURL(/\/entrar/)
  })

  test('sin sesión, el perfil redirige al login', async ({ page }) => {
    await page.goto('/perfil?anon=1')

    await expect(page).toHaveURL(/\/entrar/)
  })
})
