# Publicar los paquetes (lo hace el dueño, con sus cuentas)

Orden: primero `sharkpos` (npm), porque `sharkpos-mcp` depende de él.

1. **npm** (cuenta en https://www.npmjs.com/signup, con 2FA):
   ```bash
   npm login
   cd node && npm publish --access public && cd ..
   cd mcp && npm install && npm test && npm publish --access public && cd ..
   ```
   `npm install` en `mcp/` cambia el `package-lock.json` para usar `sharkpos` de npm: haz commit de ese cambio.
2. **PyPI** (cuenta en https://pypi.org/account/register/ y un API token):
   ```bash
   cd python && python -m pip install build twine && python -m build && python -m twine upload dist/*
   ```
3. **Registro oficial de MCP** (https://modelcontextprotocol.io/registry/quickstart), con `mcp-publisher` de
   https://github.com/modelcontextprotocol/registry/releases:
   ```bash
   mcp-publisher login github            # autoriza en el navegador con la cuenta Notzeiro
   cd mcp && mcp-publisher publish && cd ..                      # servidor local (npm sharkpos-mcp)
   cd ../"sharkpos api"/api-landing/mcp-registro && mcp-publisher publish   # servidor remoto de documentación
   ```
