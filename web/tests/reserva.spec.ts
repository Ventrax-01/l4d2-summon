/* El flujo estrella: reservar y recibir el servidor.

   El escenario corre a x20, así que las duraciones reales (~45 s y ~3 min) se comprimen
   a segundos. Lo que se verifica es la FORMA del flujo —cuántas etapas, cuáles, y qué se
   entrega al final—, no el tiempo exacto. */

import { expect, test } from '@playwright/test'

/** El poller refresca cada 4 s con un intent en curso; la entrega puede tardar eso más. */
const ESPERA_ENTREGA = 30_000

test.describe('Reserva con el sistema despierto (~45 s)', () => {
  test('el stepper tiene 3 etapas, sin la de encendido', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')

    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page).toHaveURL(/\/reservar/)

    const pasos = page.getByRole('list', { name: 'Progreso de la preparación' }).getByRole('listitem')
    await expect(pasos).toHaveCount(3)
    await expect(pasos.nth(0)).toContainText('Iniciando')
    await expect(pasos.nth(1)).toContainText('Verificando')
    await expect(pasos.nth(2)).toContainText('¡Listo!')

    // La etapa de encendido NO existe cuando el sistema ya está despierto.
    await expect(page.getByText('Despertando')).toBeHidden()
  })

  test('termina entregando el servidor con todo lo necesario', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: ESPERA_ENTREGA,
    })

    // Conectar directo.
    const conectar = page.getByRole('link', { name: /Conectar/ })
    await expect(conectar).toHaveAttribute('href', /^steam:\/\/connect\//)

    // Y la alternativa manual, copiable.
    await expect(page.getByText(/^connect play\.ventrax\.dev:\d+$/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copiar dirección' })).toBeVisible()
  })

  test('la chuleta de admin deja claro que NO puede banear', async ({ page }) => {
    await page.goto('/?host=up&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: '¡Tu servidor está listo!' })).toBeVisible({
      timeout: ESPERA_ENTREGA,
    })

    await expect(page.getByText('ERES ADMIN DE ESTE SERVIDOR')).toBeVisible()
    await expect(page.getByText('Expulsar jugadores (kick)')).toBeVisible()
    await expect(page.getByText('Cambiar de mapa')).toBeVisible()
    await expect(page.getByText(/Banear — eso no está en tus manos/)).toBeVisible()
  })
})

test.describe('Reserva con el sistema dormido (~3 min)', () => {
  test('el stepper añade la etapa de encendido al frente', async ({ page }) => {
    await page.goto('/?host=down&vel=20&n=2')

    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    const pasos = page.getByRole('list', { name: 'Progreso de la preparación' }).getByRole('listitem')
    await expect(pasos).toHaveCount(4)
    await expect(pasos.nth(0)).toContainText('Despertando')

    // El usuario nunca ve infraestructura: se habla de "servidor", no de PC ni hardware.
    const cuerpo = await page.locator('main').innerText()
    expect(cuerpo).not.toMatch(/\bPC\b|Wake-on-LAN|hardware|encender la máquina/i)
  })

  test('avisa de que tardará más', async ({ page }) => {
    await page.goto('/?host=down&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByText(/3 minutos/)).toBeVisible()
  })
})

test.describe('Fallo al preparar', () => {
  test('explica sin culpar al usuario y ofrece reintentar', async ({ page }) => {
    await page.goto('/?host=up&vel=20&falla=1&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()

    await expect(page.getByRole('alert')).toContainText('No pudimos preparar tu servidor', {
      timeout: ESPERA_ENTREGA,
    })
    await expect(page.getByText(/no es culpa tuya/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Avisar al operador' })).toBeVisible()
  })
})

test.describe('La reserva sobrevive a la navegación', () => {
  test('se puede volver a la lista y el progreso sigue', async ({ page }) => {
    await page.goto('/?host=down&vel=20&n=2')
    await page.getByRole('button', { name: /Reservar servidor/ }).click()
    await expect(page.getByRole('heading', { name: 'Preparando tu servidor' })).toBeVisible()

    await page.getByRole('button', { name: /Volver a la lista/ }).click()
    await expect(page).toHaveURL(/\/$|\/\?/)

    // El slot aparece como preparándose para todo el mundo.
    await expect(page.getByText('Alguien lo está reservando ahora mismo…')).toBeVisible()
  })
})
