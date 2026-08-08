/* Lo que ve cualquiera, con y sin sesión. */

import { expect, test } from '@playwright/test'

test.describe('Home pública', () => {
  test('se ve la flota sin iniciar sesión', async ({ page }) => {
    await page.goto('/?anon=1&n=4')

    await expect(page.getByRole('heading', { name: 'Reserva y juega en minutos' })).toBeVisible()
    await expect(page.getByRole('article')).toHaveCount(4)

    // Sin sesión, la cabecera invita a entrar y el CTA avisa de que hará falta.
    await expect(page.getByRole('button', { name: 'Entrar con Steam' })).toBeVisible()
    await expect(page.getByText('Te pediremos entrar con Steam primero.')).toBeVisible()
  })

  test('reservar sin sesión lleva al login', async ({ page }) => {
    await page.goto('/?anon=1')

    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page).toHaveURL(/\/entrar/)
    await expect(page.getByRole('heading', { name: 'VENTRAX' })).toBeVisible()
  })

  test('el número de servidores es dinámico, no fijo en 4', async ({ page }) => {
    // Un solo servidor.
    await page.goto('/?anon=1&n=1')
    await expect(page.getByRole('article')).toHaveCount(1)

    // Y el máximo previsto por el diseño.
    await page.goto('/?anon=1&n=8')
    await expect(page.getByRole('article')).toHaveCount(8)
  })

  test('la nota del cierre automático se comunica como algo normal', async ({ page }) => {
    await page.goto('/?anon=1')
    await expect(page.getByText(/queda vacío un rato, se cierra solo/)).toBeVisible()
  })

  test('un servidor libre se muestra como disponible', async ({ page }) => {
    await page.goto('/?anon=1&n=2')

    const primera = page.getByRole('article').first()
    await expect(primera.getByText('LIBRE')).toBeVisible()
    await expect(primera.getByText(/Disponible/)).toBeVisible()
  })

  test('los servidores ocupados muestran dueño, mapa y jugadores', async ({ page }) => {
    await page.goto('/?anon=1&ocupados=1&n=3')

    const primera = page.getByRole('article').first()
    // exact para no chocar con el texto alternativo de lectores ("Servidor en juego").
    await expect(primera.getByText('EN JUEGO', { exact: true })).toBeVisible()
    await expect(primera.getByRole('link', { name: 'Entrar a jugar' })).toBeVisible()
    // El contador de jugadores tiene la forma N/M.
    await expect(primera.getByText(/\d+\/\d+/)).toBeVisible()
  })
})

test.describe('Login', () => {
  test('entrar con Steam abre sesión y vuelve a la lista', async ({ page }) => {
    await page.goto('/entrar?anon=1')

    await page.getByRole('button', { name: 'Entrar con Steam' }).click()

    await expect(page).toHaveURL(/\/$|\/\?/)
    // Con sesión ya no aparece el aviso de que hará falta entrar.
    await expect(page.getByText('Te pediremos entrar con Steam primero.')).toBeHidden()
  })

  test('si el login falla se explica y se puede reintentar', async ({ page }) => {
    await page.goto('/entrar?anon=1&login=0')
    // El escenario de fallo se fija por almacenamiento; se activa vía el panel demo.
    await page.evaluate(() => {
      const clave = 'l4d2panel.escenario'
      const actual = JSON.parse(localStorage.getItem(clave) ?? '{}')
      localStorage.setItem(clave, JSON.stringify({ ...actual, loginFalla: true }))
    })
    await page.reload()

    await page.getByRole('button', { name: 'Entrar con Steam' }).click()

    await expect(page.getByRole('alert')).toContainText('No pudimos iniciar sesión')
  })
})
