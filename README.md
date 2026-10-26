# Browser-AI

An AI-powered browser application built with Tauri, React, and TypeScript. This desktop application provides an intelligent browsing experience with advanced features and a responsive UI.

## Features

- 🤖 AI-powered browser capabilities
- ⚡ Built with Tauri for lightweight desktop performance
- ⚙️ Modern React + TypeScript stack
- 🎨 Responsive UI with side panel support
- 📦 Cross-platform desktop application

## Tech Stack

- **Frontend**: React, TypeScript, Vite
- **Desktop**: Tauri
- **Backend**: Rust
- **Package Manager**: npm

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites/)

### Installation

```bash
# Install dependencies
npm install

# Development
npm run dev

# Build for production
npm run build
```

## Development

- **Frontend dev**: `npm run dev`
- **Build**: `npm run build`
- **Tauri build**: Build configured in `src-tauri/`

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Project Structure

```
├── src/                    # React frontend
│   ├── components/        # React components
│   ├── store/            # State management
│   └── types/            # TypeScript types
├── src-tauri/            # Tauri backend
│   ├── src/              # Rust code
│   └── capabilities/     # Tauri capabilities
└── public/               # Static assets
```

## License

MIT
