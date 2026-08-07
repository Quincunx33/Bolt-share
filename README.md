# BoltDrop

A secure, ultra-fast, direct peer-to-peer (P2P) file sharing application built for modern browsers. BoltDrop uses native WebRTC connection channels to securely stream photos, videos, archives, and documents directly between devices without intermediate servers or storage limits.

---

## Highlights

- **Direct P2P Streaming:** Streams files byte-by-byte directly from the sender's browser to the receiver. No file size limits, and no server storage.
- **Dual Progress Visualization:** Real-time transfer stats showing both individual file progress and overall batch progress.
- **Customizable Identity:** Share your generated peer name or use clean custom URLs for quick, branded room sharing.
- **Zero Configuration:** Automatically discovers other peers on your local Wi-Fi, or connect globally with a few clicks.

---

## How It Works

1. **Signaling & Discovery:** BoltDrop initializes a secure signaling channel to let browsers find each other.
2. **WebRTC Connection:** Once discovered, peers establish direct WebRTC data channels.
3. **Chunked Stream:** Files are divided into small chunks and sent over the secure WebRTC connection.
4. **Local Reconstitution:** The receiving browser reassembles the chunks in memory and automatically initiates a local download once fully received.

---

## Tech Stack

- **Core Engine:** HTML5, CSS3, ES6+ Javascript
- **Network Protocol:** Native WebRTC & PeerJS
- **Build System:** Vite & Bun

---

## Getting Started

### Local Development

Install the package dependencies:
```bash
npm install
```

Start the development server:
```bash
npm run dev
```

Open `http://localhost:3000` in multiple tabs or different devices on your network to experience P2P transfer.

### Production Build

Generate optimized static assets:
```bash
npm run build
```

The compiled output will be available in the `dist` directory, ready to be deployed to any static hosting provider.
