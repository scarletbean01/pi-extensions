# Materialize CSS (Vendored)

- **Package:** `materialize-css@1.0.0`
- **License:** MIT (see `LICENSE` in this directory)
- **Tarball SHA-512 integrity (verified by `npm pack materialize-css@1.0.0`):**
  `sha512-4/oecXl8y/1i8RDZvyvwAICyqwNoKU4or5uf8uoAd74k76KzZ0Llym4zhJ5lLNUskcqjO0AuMcvNyDkpz8Z6zw==`
- **Tarball SHA-1 shasum:** `8d5db1c4a81c6d65f3b2e2ca83a8e08daa24d1be`
- **Files vendored:** `materialize.min.css` (from `dist/css/materialize.min.css`) and `LICENSE`.
- **Excluded intentionally:** Materialize JS (`dist/js/*`), Material Icons font, and Roboto / Google Fonts. Drawer and accordion interactions are implemented in local accessible vanilla JavaScript; `style.css` overrides the font family with the local system font stack.
- **Modifications to `materialize.min.css`:** Stripped the four `http://` and `https://` URLs inside the embedded Materialize and Waves MIT license comments (retaining copyright and MIT license attribution) so the vendored stylesheet contains zero `http://`, `https://`, or `//` URLs. No CSS rules were modified.
