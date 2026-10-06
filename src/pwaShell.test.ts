import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import manifestText from '../public/manifest.webmanifest?raw'

/*
  Guards for the installable-shell files (manifest, iOS tags, icons) so a
  later edit cannot quietly break "Add to Home Screen". These check the
  files as written; the real proof is installing on the iPad.
*/

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string }

const manifest = JSON.parse(manifestText) as {
  id: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  orientation?: string
  icons: ManifestIcon[]
}

/* Every PNG in public/, as a base64 data URL (so the bytes can be inspected). */
const publicPngs = import.meta.glob('../public/*.png', {
  query: '?inline',
  import: 'default',
  eager: true,
}) as Record<string, string>

function pngInfo(fileName: string): { width: number; height: number; colourType: number } {

  const dataUrl = publicPngs[`../public/${fileName}`]

  expect(dataUrl, `public/${fileName} should exist`).toBeTruthy()

  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)

  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colourType: bytes[25],
  }

}

describe('web app manifest', () => {

  it('names the app ToothTarget and opens it as a standalone (full-screen) app', () => {
    expect(manifest.name).toBe('ToothTarget')
    expect(manifest.short_name).toBe('ToothTarget')
    expect(manifest.display).toBe('standalone')
  })

  it('uses the app background colour for both the splash and the theme', () => {
    expect(manifest.background_color).toBe('#f1f2f5')
    expect(manifest.theme_color).toBe('#f1f2f5')
  })

  it('does not lock the orientation (portrait and landscape both work)', () => {
    expect(manifest.orientation).toBeUndefined()
  })

  it('uses relative addresses, so it works at /ToothTarget/ in production and / in local dev', () => {
    for (const value of [manifest.id, manifest.start_url, manifest.scope, ...manifest.icons.map(icon => icon.src)]) {
      expect(value.startsWith('/')).toBe(false)
      expect(value).not.toContain('ToothTarget/')
      expect(value).not.toMatch(/^https?:/)
    }

    const production = 'https://7okas.github.io/ToothTarget/manifest.webmanifest'
    const local = 'http://localhost:5173/manifest.webmanifest'

    expect(new URL(manifest.start_url, production).pathname).toBe('/ToothTarget/')
    expect(new URL(manifest.scope, production).pathname).toBe('/ToothTarget/')
    expect(new URL(manifest.start_url, local).pathname).toBe('/')
    expect(new URL(manifest.scope, local).pathname).toBe('/')

    for (const icon of manifest.icons) {
      expect(new URL(icon.src, production).pathname).toBe(`/ToothTarget/${icon.src}`)
    }
  })

  it('lists 192 and 512 icons, plus a separate maskable 512 icon', () => {
    const bySize = (size: string, purpose: string) =>
      manifest.icons.filter(icon => icon.sizes === size && icon.purpose === purpose)

    expect(bySize('192x192', 'any')).toHaveLength(1)
    expect(bySize('512x512', 'any')).toHaveLength(1)
    expect(bySize('512x512', 'maskable')).toHaveLength(1)
    expect(manifest.icons.every(icon => icon.type === 'image/png')).toBe(true)
    // "maskable" is its own entry, never combined with "any" in one image.
    expect(manifest.icons.some(icon => icon.purpose.includes('any') && icon.purpose.includes('maskable'))).toBe(false)
  })

  it('every icon it lists exists in public/ at the size it claims', () => {
    for (const icon of manifest.icons) {
      const info = pngInfo(icon.src)
      expect(`${info.width}x${info.height}`).toBe(icon.sizes)
    }
  })

})

describe('placeholder icons are fully opaque', () => {

  it.each([
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ])('%s is %i px and has no alpha channel (PNG colour type 2 = plain RGB), so iOS cannot draw black corners', (file, size) => {
    const info = pngInfo(file)
    expect(info.width).toBe(size)
    expect(info.height).toBe(size)
    expect(info.colourType).toBe(2)
  })

})

describe('index.html - iOS web app tags', () => {

  it('links the manifest and the opaque 180px apple-touch-icon through the base path', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="%BASE_URL%manifest.webmanifest" />')
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="%BASE_URL%apple-touch-icon.png" />')
  })

  it('no longer points the apple-touch-icon at the old transparent 192px favicon', () => {
    expect(indexHtml).not.toMatch(/rel="apple-touch-icon"[^>]*favicon-192/)
  })

  it('has the home-screen app tags: capable, title, status bar "default", theme colour', () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    expect(indexHtml).toContain('<meta name="mobile-web-app-capable" content="yes" />')
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="ToothTarget" />')
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />')
    expect(indexHtml).toContain('<meta name="theme-color" content="#f1f2f5" />')
  })

  it('leaves the viewport as it was (no viewport-fit, so no safe-area work is needed)', () => {
    expect(indexHtml).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />')
    expect(indexHtml).not.toContain('viewport-fit')
  })

  it('keeps the existing favicon links', () => {
    expect(indexHtml).toContain('href="/src/assets/favicon.ico"')
    expect(indexHtml).toContain('href="/src/assets/favicon-32.png"')
    expect(indexHtml).toContain('href="/src/assets/favicon-192.png"')
  })

})
