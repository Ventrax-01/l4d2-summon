/* Lo que trajo el rediseño de agosto: hero con contadores, reserva por tarjeta,
   sección explicativa, pie global y avisos. */

import { expect, test } from '@playwright/test'

test.describe('Hero de la home', () => {
  test('resume el estado de la flota en contadores', async ({ page }) => {
    await page.goto('/?anon=1&n=4')

    await expect(page.getByRole('heading', { name: 'Reserva y juega en minutos' })).toBeVisible()
    await expect(page.getByText('LIBRES')).toBeVisible()
    await expect(page.getByText('PREPARANDO', { exact: true })).toBeVisible()
    await expect(page.getByText('EN JUEGO', { exact: true })).toBeVisible()
  })

  test('los contadores reflejan la flota real', async ({ page }) => {
    // Todo ocupado: cero libres y todos en juego.
    await page.goto('/?anon=1&ocupados=1&n=3')
    const libres = page.locator('.hero-num--libre')
    const enJuego = page.locator('.hero-num--juego')
    await expect(libres).toHaveText('0')
    await expect(enJuego).toHaveText('3')
  })
})

test.describe('Reservar desde la tarjeta', () => {
  test('un servidor libre ofrece reservarlo directamente', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    const primera = page.getByRole('article').first()
    await expect(primera.getByRole('button', { name: 'Reservar este' })).toBeVisible()
  })

  test('sin sesión, reservar desde la tarjeta lleva al login', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    await page.getByRole('button', { name: 'Reservar este' }).first().click()

    await expect(page).toHaveURL(/\/entrar/)
  })

  test('un servidor libre muestra su próximo mapa', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    await expect(page.getByText(/Próximo mapa ·/).first()).toBeVisible()
  })
})

test.describe('Cómo funciona', () => {
  test('explica los tres pasos a quien llega por primera vez', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    await expect(page.getByText('CÓMO FUNCIONA')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Reserva un servidor' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Espera a que arranque' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Conéctate con tu grupo' })).toBeVisible()
  })

  test('deja claras las reglas que sorprenden', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    await expect(page.getByText(/Un servidor por persona/)).toBeVisible()
    await expect(page.getByText(/queda vacío un rato, se cierra solo/)).toBeVisible()
  })
})

test.describe('Pie global', () => {
  test('aparece en la home y en las pantallas internas', async ({ page }) => {
    await page.goto('/?anon=1&n=2')
    await expect(page.getByText(/Hecho con mucho café y amor/)).toBeVisible()

    await page.goto('/entrar?anon=1')
    await expect(page.getByText(/Hecho con mucho café y amor/)).toBeVisible()
  })
})

test.describe('Avisos', () => {
  test('con un servidor propio, reservar otra vez avisa en vez de fallar', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: 30_000,
    })

    // Vuelvo a la lista navegando por la app (no con goto: una recarga reiniciaría
    // el mundo simulado del mock y perdería el servidor recién reservado).
    await page.getByRole('link', { name: /VENTRAX/ }).click()
    await expect(page.getByRole('heading', { name: 'Reserva y juega en minutos' })).toBeVisible()
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByText(/Ya tienes un servidor activo/)).toBeVisible()
  })

  test('copiar la dirección confirma con un aviso', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'permiso de portapapeles solo en Chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])

    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: 30_000,
    })

    await page.getByRole('button', { name: 'Copiar dirección' }).click()
    await expect(page.getByRole('button', { name: 'Copiar dirección' })).toContainText('✓')
  })
})

test.describe('Servicio caído', () => {
  test('anuncia el reintento automático', async ({ page }) => {
    await page.goto('/?caido=1')

    await expect(page.getByRole('heading', { name: 'Estamos fuera de línea' })).toBeVisible()
    await expect(page.getByText(/Reintento automático en \d+ s/)).toBeVisible()
    await expect(page.getByText(/tu reserva se conserva/)).toBeVisible()
  })
})
