# LeanBot

An economical and smart bot architecture designed for efficiency and minimal resource consumption.

## Philosophy

- **Lean**: Minimal dependencies, small footprint
- **Economical**: Optimized token usage, smart caching, cost-aware routing
- **Smart**: Intelligent context management, efficient memory handling

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      LeanBot Core                        │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Router    │  │   Cache     │  │   Memory    │     │
│  │  (Smart     │  │  (Token     │  │  (Efficient │     │
│  │   Routing)  │  │   Saving)   │  │   Context)  │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Channels   │  │   Skills    │  │  Providers  │     │
│  │  (I/O)      │  │  (Actions)  │  │  (LLMs)     │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
leanbot/
├── src/
│   ├── core/           # Core bot engine
│   ├── router/         # Smart message routing
│   ├── cache/          # Response & context caching
│   ├── memory/         # Efficient memory management
│   ├── channels/       # Input/output channels
│   ├── skills/         # Modular capabilities
│   └── providers/      # LLM provider integrations
├── config/             # Configuration files
├── tests/              # Test suites
└── docs/               # Documentation
```

## Getting Started

```bash
# Install dependencies
npm install

# Configure your bot
cp config/example.yaml config/local.yaml

# Run LeanBot
npm start
```

## Key Features (Planned)

- [ ] Cost-aware model routing (use cheaper models when possible)
- [ ] Intelligent response caching
- [ ] Compressed context management
- [ ] Multi-channel support
- [ ] Modular skill system
- [ ] Local-first with optional cloud sync

## License

MIT
