# Materialize CSS (Vendored)

- **Package:** `materialize-css@1.0.0`
- **License:** MIT (see `LICENSE` in this directory)
- **Tarball SHA-512 integrity (verified by `npm pack materialize-css@1.0.0`):**
  `sha512-4/oecXl8y/1i8RDZvyvwAICyqwNoKU4or5uf8uoAd74k76KzZ0Llym4zhJ5lLNUskcqjO0AuMcvNyDkpz8Z6zw==`
- **Tarball SHA-1 shasum:** `8d5db1c4a81c6d65f3b2e2ca83a8e08daa24d1be`
- **Files vendored:** `materialize.min.css` (from `dist/css/materialize.min.css`) and `LICENSE`.
- **Excluded intentionally:** Materialize JS (`dist/js/*`), Material Icons font, and Roboto / Google Fonts. Materialize JS is excluded because Waves writes inline `style` attributes that the viewer's strict Content Security Policy blocks (`style-src 'self'`), and Sidenav has no focus management, focus trapping, `inert` handling, or ARIA state handling; drawer, tab, and accordion interactions instead use local accessible vanilla JavaScript and native `<details>`/`<summary>`. Materialize's own system font stack is used without a local body/system font-family override (`style.css` only sets a monospace font-family on `code, .mono`), and icons remain inline SVG.
- **Modifications to `materialize.min.css`:** Stripped the four `http://` and `https://` URLs inside the embedded Materialize and Waves MIT license comments (retaining copyright and MIT license attribution) so the vendored stylesheet contains zero `http://`, `https://`, or `//` URLs. No CSS rules were modified.
