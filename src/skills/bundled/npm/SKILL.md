---
name: npm
description: Node.js package management - install, update, run scripts
user-invocable: true
metadata:
  openclaw:
    emoji: "\U0001F4E6"
    safety:
      localWrite: true
    requires:
      bins: [npm]
---

# NPM Skill

Help the user with Node.js package management.

## Capabilities

- **Install**: Install packages and dependencies
- **Update**: Update packages to latest versions
- **Scripts**: Run npm scripts defined in package.json
- **Search**: Find packages on npm registry
- **Publish**: Publish packages to npm
- **Audit**: Check for security vulnerabilities

## Guidelines

1. Check `package.json` before suggesting package operations
2. Use `--save-dev` for development dependencies
3. Run `npm audit` after installing packages
4. Suggest `npm ci` for CI/CD environments (faster, stricter)
5. Check for peer dependency warnings

## Common Commands

```bash
npm install                   # Install all dependencies
npm install package-name      # Install a package
npm install -D package        # Install as dev dependency
npm update                    # Update all packages
npm run script-name           # Run a script from package.json
npm audit                     # Check for vulnerabilities
npm audit fix                 # Fix vulnerabilities
npm outdated                  # Check for outdated packages
npm list --depth=0            # List installed packages
```
