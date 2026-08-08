/* La cola: qué pasa cuando no hay sitio. */

import { expect, test } from '@playwright/test'

/** El motor promueve al primero de la cola a los 25 s reales; a x20 son ~1,3 s, pero el
    poller refresca cada 4 s. */
const ESPERA_TURNO = 30_000

test.describe('Cola de espera', () => {
  test('con todo ocupado, reservar mete en la cola con su posición', async ({ page }) => {
    await page.goto('/?ocupados=1&vel=20&n=3')

    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page).toHaveURL(/\/cola/)
    await expect(page.getByText('EN COLA')).toBeVisible()
    await expect(page.getByText('tu posición en la cola')).toBeVisible()
    await expect(page.getByText(/todos los servidores están ocupados/)).toBeVisible()
  })

  test('tranquiliza: el sitio se guarda aunque dejes la pestaña de fondo', async ({ page }) => {
    await page.goto('/?ocupados=1&vel=20&n=3')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByText(/tu sitio se guarda/)).toBeVisible()
  })

  test('cuando toca el turno, avisa con cuenta atrás y CTA para entrar', async ({ page }) => {
    await page.goto('/?ocupados=1&vel=20&n=3')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByText('¡ES TU TURNO!')).toBeVisible({ timeout: ESPERA_TURNO })
    await expect(page.getByRole('button', { name: 'Entrar ahora' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ceder mi turno' })).toBeVisible()
    // La cuenta atrás tiene formato mm:ss.
    await expect(page.getByText(/^\d{2}:\d{2}$/)).toBeVisible()
    await expect(page.getByText(/el turno pasa al siguiente/)).toBeVisible()
  })

  test('se puede salir de la cola', async ({ page }) => {
    await page.goto('/?ocupados=1&vel=20&n=3')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByText('EN COLA')).toBeVisible()

    await page.getByRole('button', { name: 'Salir de la cola' }).click()

    await expect(page).toHaveURL(/\/$|\/\?/)
    await expect(page.getByRole('heading', { name: 'Servidores' })).toBeVisible()
  })

  test('reclamar el turno arranca la preparación', async ({ page }) => {
    await page.goto('/?ocupados=1&vel=20&n=3')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByText('¡ES TU TURNO!')).toBeVisible({ timeout: ESPERA_TURNO })

    await page.getByRole('button', { name: 'Entrar ahora' }).click()

    await expect(page).toHaveURL(/\/reservar/)
    await expect(page.getByRole('heading', { name: 'Preparando tu servidor' })).toBeVisible()
  })
})
