// main.js — UI wiring

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA] ServiceWorker registered with scope:', reg.scope);
      })
      .catch((err) => {
        console.error('[PWA] ServiceWorker registration failed:', err);
      });
  });
}

import { FileSharePeer } from './peer.js'

// ── DOM refs ──
const myPeerIdEl      = document.getElementById('my-peer-id')
const statusMsg       = document.getElementById('status-msg')
const peersContainer  = document.getElementById('peers-container')

// Send modal
const sendModal       = document.getElementById('send-modal')
const modalPeerName   = document.getElementById('modal-peer-name')
const fileInput       = document.getElementById('file-input')
const filePickLabel   = document.getElementById('file-pick-label')
const fileNameDisplay = document.getElementById('file-name-display')
const sendBtn         = document.getElementById('send-btn')
const cancelBtn       = document.getElementById('cancel-btn')
const progressWrap    = document.getElementById('progress-wrap')
const progressFill    = document.getElementById('progress-fill')
const progressLabel   = document.getElementById('progress-label')
const transferSpeed   = document.getElementById('transfer-speed')
const individualProgressSection = document.getElementById('individual-progress-section')
const individualFileTitle       = document.getElementById('individual-file-title')
const individualProgressLabel   = document.getElementById('individual-progress-label')
const individualProgressFill    = document.getElementById('individual-progress-fill')
const aggregateProgressSection  = document.getElementById('aggregate-progress-section')
const filePreviewContainer = document.getElementById('file-preview-container')
let previewObjectUrls = []

// Recent Transfers DOM refs
const transfersPanel  = document.getElementById('transfers-panel')
const transfersEmpty  = document.getElementById('transfers-empty')
const transfersList   = document.getElementById('transfers-list')
const clearTransfersBtn = document.getElementById('clear-transfers-btn')

// Media Viewer DOM refs
const mediaViewerModal = document.getElementById('media-viewer-modal')
const mediaViewerCloseBg = document.getElementById('media-viewer-close-bg')
const mediaViewerName = document.getElementById('media-viewer-name')
const mediaViewerSize = document.getElementById('media-viewer-size')
const mediaViewerDownload = document.getElementById('media-viewer-download')
const mediaViewerClose = document.getElementById('media-viewer-close')
const mediaViewerContent = document.getElementById('media-viewer-content')

// Receive toast
const receiveToast    = document.getElementById('receive-toast')
const toastTitle      = document.getElementById('toast-title')
const toastFile       = document.getElementById('toast-file')
const acceptBtn       = document.getElementById('accept-btn')
const declineBtn      = document.getElementById('decline-btn')
const toastTransferSpeed = document.getElementById('toast-transfer-speed')

// ── State ──
let activePeerId = null
const peerNodes  = new Map() // peerId → DOM element
let sessionTransfers = [] // Array of { name, size, direction: 'sent'|'received', data: File|Blob }
let activeViewerUrl = null


// ── Peer positions on radar rings ──
const POSITIONS = [
  { x: 50, y: 22 },
  { x: 78, y: 50 },
  { x: 50, y: 78 },
  { x: 22, y: 50 },
  { x: 50, y: 10 },
  { x: 83, y: 28 },
  { x: 90, y: 60 },
  { x: 65, y: 88 },
  { x: 35, y: 88 },
  { x: 10, y: 60 },
  { x: 17, y: 28 },
]

function getPosition(index) {
  return POSITIONS[index % POSITIONS.length]
}

const AVATARS = [
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="7" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><path d="M9.5 16 Q12 17.5 14.5 16" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M8 7 Q9 5 10 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M14 7 Q15 5 16 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1.2" fill="currentColor"/><path d="M9 15.5 Q12 17 15 15.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><ellipse cx="12" cy="14" rx="2.5" ry="1.5" fill="currentColor" opacity="0.15"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="11" r="1.3" fill="currentColor"/><circle cx="14.5" cy="11" r="1.3" fill="currentColor"/><path d="M10 15.5 Q12 17 14 15.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M7 7 L9 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M17 7 L15 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="13" rx="7" ry="6" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="12" r="1.2" fill="currentColor"/><circle cx="14.5" cy="12" r="1.2" fill="currentColor"/><ellipse cx="12" cy="14.5" rx="2" ry="1.2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1"/><circle cx="7.5" cy="8" r="2" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/><circle cx="16.5" cy="8" r="2" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/></svg>`,
]

function getAvatar(index) {
  return AVATARS[index % AVATARS.length]
}

function getCustomUsernameFromUrl() {
  try {
    const path = window.location.pathname;
    const cleanPath = decodeURIComponent(path.replace(/^\/+/g, '').replace(/\/+$/g, '')).trim();
    if (cleanPath && !cleanPath.includes('.') && cleanPath !== 'signal' && cleanPath !== 'index.html') {
      return cleanPath;
    }
  } catch (e) {
    console.error('Error parsing custom username from URL:', e);
  }
  return null;
}

function peerLabel(peerId) {
  // If it's a custom username with a random suffix (e.g., Anik_3849)
  if (peerId.includes('_')) {
    const parts = peerId.split('_')
    // Remove the last part if it is a number (our unique suffix)
    if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
      return parts.slice(0, -1).join('_')
    }
  }

  // If it's an auto-generated ID (adj-noun-number, e.g. swift-fox-283)
  const parts = peerId.split('-')
  if (parts.length === 3 && !isNaN(parts[2])) {
    return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  }

  return peerId
}

// ── Pending Connection Request Radar State ──
function setPendingRequestState(isPending) {
  const radarStage = document.getElementById('radar-stage')
  if (!radarStage) return
  if (isPending) {
    radarStage.classList.add('has-pending-request')
  } else {
    const sendModalVisible = sendModal && !sendModal.classList.contains('hidden')
    const receiveToastVisible = receiveToast && !receiveToast.classList.contains('hidden')
    if (!sendModalVisible && !receiveToastVisible) {
      radarStage.classList.remove('has-pending-request')
    }
  }
}

// ── Add peer node to radar ──
let peerCount = 0
function addPeerNode(peerId) {
  if (peerNodes.has(peerId)) return
  const pos = getPosition(peerCount)
  peerCount++

  const node = document.createElement('div')
  node.className = 'node peer-node new-discovery-burst'
  node.style.left = `${pos.x}%`
  node.style.top  = `${pos.y}%`
  node.dataset.peerId = peerId

  node.innerHTML = `
    <div class="node-ripple-container">
      <div class="node-ripple-wave wave-1"></div>
      <div class="node-ripple-wave wave-2"></div>
      <div class="node-ripple-wave wave-3"></div>
    </div>
    <div class="avatar">${getAvatar(peerCount)}</div>
    <span>${peerLabel(peerId)}</span>
  `

  node.addEventListener('click', () => openSendModal(peerId))
  peersContainer.appendChild(node)
  peerNodes.set(peerId, node)

  setTimeout(() => {
    node.classList.remove('new-discovery-burst')
  }, 2000)

  setStatus(`${peerNodes.size} peer${peerNodes.size > 1 ? 's' : ''} nearby — click to send`)
}

function removePeerNode(peerId) {
  const node = peerNodes.get(peerId)
  if (node) {
    node.style.opacity = '0'
    node.style.transition = 'opacity 0.3s'
    setTimeout(() => node.remove(), 300)
    peerNodes.delete(peerId)
  }
  if (peerNodes.size === 0) {
    const hash = window.location.hash.replace('#', '').trim()
    if (hash && hash !== 'internet') {
      setStatus(`Connected to Internet Room: ${hash}. Waiting for peers to join…`)
    } else if (hash === 'internet') {
      setStatus('Ready to connect. Create a new room or join an existing one.')
    } else {
      setStatus('Waiting for peers on your local network…')
    }
  } else {
    setStatus(`${peerNodes.size} peer${peerNodes.size > 1 ? 's' : ''} nearby — click to send`)
  }
}

function setStatus(text) {
  statusMsg.textContent = text
}

// ── Transfer Speed Meter Helpers ──
let transferStartTime = null
let lastSpeedUpdate = null
let lastSpeedBytes = 0
let currentSpeedText = '0 B/s'

function calculateSpeedRatio(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return 0
  const logVal = Math.log10(1 + bytesPerSec)
  const logMax = Math.log10(1 + 30 * 1024 * 1024) // 30 MB/s max scale
  return Math.min(1, Math.max(0, logVal / logMax))
}

function updateSpeedometerGauges(bytesPerSec) {
  const ratio = calculateSpeedRatio(bytesPerSec)
  const arcLength = 62.83
  const dashOffset = arcLength * (1 - ratio)
  const needleAngle = -120 + (ratio * 240)

  // Send Modal Gauge
  const sendArc = document.getElementById('gauge-arc-send')
  const sendNeedle = document.getElementById('gauge-needle-send')
  if (sendArc) sendArc.style.strokeDashoffset = dashOffset.toFixed(2)
  if (sendNeedle) sendNeedle.style.transform = `rotate(${needleAngle.toFixed(1)}deg)`

  // Receive Toast Gauge
  const recvArc = document.getElementById('gauge-arc-receive')
  const recvNeedle = document.getElementById('gauge-needle-receive')
  if (recvArc) recvArc.style.strokeDashoffset = dashOffset.toFixed(2)
  if (recvNeedle) recvNeedle.style.transform = `rotate(${needleAngle.toFixed(1)}deg)`
}

function resetSpeedTracker() {
  transferStartTime = null
  lastSpeedUpdate = null
  lastSpeedBytes = 0
  currentSpeedText = '0 B/s'
  updateSpeedometerGauges(0)
}

function calculateSpeed(currentBytes) {
  const now = Date.now()
  if (!transferStartTime) {
    transferStartTime = now
    lastSpeedUpdate = now
    lastSpeedBytes = currentBytes
    updateSpeedometerGauges(0)
    return '0 B/s'
  }
  
  const elapsedMsSinceLast = now - lastSpeedUpdate
  if (elapsedMsSinceLast >= 300) {
    const bytesDiff = Math.max(0, currentBytes - lastSpeedBytes)
    const instSpeed = bytesDiff / (elapsedMsSinceLast / 1000) // bytes per second
    currentSpeedText = formatSpeed(instSpeed)
    
    updateSpeedometerGauges(instSpeed)
    
    lastSpeedUpdate = now
    lastSpeedBytes = currentBytes
  }
  
  return currentSpeedText
}

function formatSpeed(bytesPerSec) {
  if (isNaN(bytesPerSec) || bytesPerSec < 0) return '0 B/s'
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(1) + ' B/s'
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s'
}

// ── File Previews Helper Functions ──
function clearPreviews() {
  previewObjectUrls.forEach(url => URL.revokeObjectURL(url))
  previewObjectUrls = []
  if (filePreviewContainer) {
    filePreviewContainer.innerHTML = ''
    filePreviewContainer.classList.add('hidden')
  }
}

function getFileTypeIcon(file, createUrlForPreview = false) {
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()

  if (type.startsWith('image/') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.gif') || name.endsWith('.webp') || name.endsWith('.svg')) {
    if (createUrlForPreview && (file instanceof File || file instanceof Blob)) {
      const url = URL.createObjectURL(file)
      previewObjectUrls.push(url)
      return `<img class="file-preview-thumbnail" src="${url}" alt="${file.name}" />`
    }
    return `
      <div class="file-preview-icon" style="color: #2563eb; background-color: rgba(37, 99, 235, 0.05); border-color: rgba(37, 99, 235, 0.15);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </div>
    `
  }

  let strokeColor = 'var(--accent)'
  let bgColor = 'rgba(37, 99, 235, 0.05)'
  let svgContent = ''

  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    strokeColor = '#ef4444'
    bgColor = 'rgba(239, 68, 68, 0.05)'
    svgContent = `
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="9" y1="15" x2="15" y2="15"></line>
    `
  } else if (type.startsWith('audio/') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.ogg') || name.endsWith('.m4a') || name.endsWith('.flac')) {
    strokeColor = '#8b5cf6'
    bgColor = 'rgba(139, 92, 246, 0.05)'
    svgContent = `
      <path d="M9 18V5l12-2v13"></path>
      <circle cx="6" cy="18" r="3"></circle>
      <circle cx="18" cy="16" r="3"></circle>
    `
  } else if (type.startsWith('video/') || name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.avi') || name.endsWith('.webm') || name.endsWith('.mov')) {
    strokeColor = '#10b981'
    bgColor = 'rgba(16, 185, 129, 0.05)'
    svgContent = `
      <polygon points="23 7 16 12 23 17 23 7"></polygon>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    `
  } else if (type.includes('zip') || type.includes('tar') || type.includes('rar') || type.includes('compressed') || name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.tar') || name.endsWith('.gz') || name.endsWith('.7z')) {
    strokeColor = '#f59e0b'
    bgColor = 'rgba(245, 158, 11, 0.05)'
    svgContent = `
      <polyline points="21 8 21 21 3 21 3 8"></polyline>
      <rect x="1" y="3" width="22" height="5" rx="1"></rect>
      <line x1="10" y1="12" x2="14" y2="12"></line>
    `
  } else if (type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.doc') || name.endsWith('.docx') || name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.ppt') || name.endsWith('.pptx') || name.endsWith('.json') || name.endsWith('.js') || name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.md')) {
    strokeColor = '#6b7280'
    bgColor = 'rgba(107, 114, 128, 0.05)'
    svgContent = `
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    `
  } else {
    strokeColor = 'var(--accent)'
    bgColor = 'rgba(37, 99, 235, 0.05)'
    svgContent = `
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
    `
  }

  return `
    <div class="file-preview-icon" style="color: ${strokeColor}; background-color: ${bgColor}; border-color: ${strokeColor}20;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${svgContent}
      </svg>
    </div>
  `
}

function renderFilePreviews(files) {
  clearPreviews()
  if (!files || files.length === 0) return

  if (filePreviewContainer) {
    filePreviewContainer.classList.remove('hidden')
    Array.from(files).forEach(file => {
      const item = document.createElement('div')
      item.className = 'file-preview-item'
      
      const iconHtml = getFileTypeIcon(file, true)
      
      item.innerHTML = `
        ${iconHtml}
        <div class="file-preview-info">
          <div class="file-preview-name" title="${file.name}">${file.name}</div>
          <div class="file-preview-size">${formatBytes(file.size)}</div>
        </div>
      `
      
      item.addEventListener('click', () => {
        openMediaViewer(file.name, file.size, file)
      })

      filePreviewContainer.appendChild(item)
    })
  }
}

// ── Media Viewer Overlay Modal Actions ──
function openMediaViewer(name, size, target) {
  if (!mediaViewerModal || !mediaViewerContent) return

  mediaViewerContent.innerHTML = ''
  
  if (activeViewerUrl) {
    try {
      URL.revokeObjectURL(activeViewerUrl)
    } catch (e) {}
    activeViewerUrl = null
  }

  let fileUrl = ''
  let isImage = false
  let isVideo = false

  const nameLower = name.toLowerCase()
  if (nameLower.endsWith('.png') || nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg') || nameLower.endsWith('.gif') || nameLower.endsWith('.webp') || nameLower.endsWith('.svg')) {
    isImage = true
  } else if (nameLower.endsWith('.mp4') || nameLower.endsWith('.mkv') || nameLower.endsWith('.avi') || nameLower.endsWith('.webm') || nameLower.endsWith('.mov')) {
    isVideo = true
  }

  if (target instanceof File || target instanceof Blob) {
    fileUrl = URL.createObjectURL(target)
    activeViewerUrl = fileUrl
  } else if (typeof target === 'string') {
    fileUrl = target
  }

  if (mediaViewerName) mediaViewerName.textContent = name
  if (mediaViewerSize) mediaViewerSize.textContent = formatBytes(size)
  
  if (mediaViewerDownload) {
    mediaViewerDownload.href = fileUrl
    mediaViewerDownload.download = name
  }

  if (isImage) {
    const img = document.createElement('img')
    img.src = fileUrl
    img.alt = name
    mediaViewerContent.appendChild(img)
  } else if (isVideo) {
    const video = document.createElement('video')
    video.src = fileUrl
    video.controls = true
    video.autoplay = true
    mediaViewerContent.appendChild(video)
  } else {
    // Falls back gracefully for non-media types
    const fallback = document.createElement('div')
    fallback.style.color = '#94a3b8'
    fallback.style.textAlign = 'center'
    fallback.style.display = 'flex'
    fallback.style.flexDirection = 'column'
    fallback.style.alignItems = 'center'
    fallback.style.gap = '16px'
    
    const iconHtml = getFileTypeIcon({ name, type: '' }, false)
    
    fallback.innerHTML = `
      <div style="transform: scale(1.5); margin-bottom: 8px;">
        ${iconHtml}
      </div>
      <p style="font-size: 13px; font-weight: 500;">No inline player available for this file type.</p>
      <a href="${fileUrl}" download="${name}" class="media-viewer-btn btn-download" style="text-decoration: none;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
        <span>Download to Open</span>
      </a>
    `
    mediaViewerContent.appendChild(fallback)
  }

  mediaViewerModal.classList.remove('hidden')
}

function closeMediaViewer() {
  if (!mediaViewerModal) return
  mediaViewerModal.classList.add('hidden')
  
  if (mediaViewerContent) {
    const video = mediaViewerContent.querySelector('video')
    if (video) {
      video.pause()
      video.src = ''
      video.load()
    }
    mediaViewerContent.innerHTML = ''
  }

  if (activeViewerUrl) {
    // Keep it active if it belongs to sessionTransfers to avoid breaking other downloads
    const isSavedInSession = sessionTransfers.some(t => t.objectUrl === activeViewerUrl)
    if (!isSavedInSession) {
      try {
        URL.revokeObjectURL(activeViewerUrl)
      } catch (e) {}
    }
    activeViewerUrl = null
  }
}

if (mediaViewerClose) {
  mediaViewerClose.addEventListener('click', closeMediaViewer)
}
if (mediaViewerCloseBg) {
  mediaViewerCloseBg.addEventListener('click', closeMediaViewer)
}

// Support Esc key to close viewer
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMediaViewer()
  }
})

// ── Session Transfers History manager ──
function addTransferToHistory({ name, size, direction, data }) {
  let objectUrl = ''
  if (data instanceof Blob || data instanceof File) {
    objectUrl = URL.createObjectURL(data)
  }

  const transfer = {
    name,
    size,
    direction,
    data,
    objectUrl,
    timestamp: Date.now()
  }

  sessionTransfers.unshift(transfer) // Add to start of list

  if (transfersPanel) {
    transfersPanel.classList.remove('hidden')
  }

  renderTransfersList()
}

function renderTransfersList() {
  if (!transfersList) return

  if (sessionTransfers.length === 0) {
    if (transfersEmpty) transfersEmpty.classList.remove('hidden')
    transfersList.innerHTML = ''
    return
  }

  if (transfersEmpty) transfersEmpty.classList.add('hidden')
  transfersList.innerHTML = ''

  sessionTransfers.forEach(transfer => {
    const item = document.createElement('div')
    item.className = 'transfer-item'
    
    const iconHtml = getFileTypeIcon({ name: transfer.name, type: '' }, false)
    const badgeText = transfer.direction === 'sent' ? 'Sent' : 'Received'
    const badgeClass = transfer.direction === 'sent' ? 'transfer-badge sent' : 'transfer-badge received'

    item.innerHTML = `
      ${iconHtml}
      <div class="transfer-item-info">
        <div class="transfer-item-title" title="${transfer.name}">${transfer.name}</div>
        <div class="transfer-item-meta">
          <span>${formatBytes(transfer.size)}</span>
          <span>•</span>
          <span class="${badgeClass}">${badgeText}</span>
        </div>
      </div>
    `

    item.addEventListener('click', () => {
      openMediaViewer(transfer.name, transfer.size, transfer.objectUrl || transfer.data)
    })

    transfersList.appendChild(item)
  })
}

if (clearTransfersBtn) {
  clearTransfersBtn.addEventListener('click', () => {
    // Revoke any created object URLs to prevent leaks
    sessionTransfers.forEach(t => {
      if (t.objectUrl) {
        try {
          URL.revokeObjectURL(t.objectUrl)
        } catch (e) {}
      }
    })
    sessionTransfers = []
    renderTransfersList()
    if (transfersPanel) {
      transfersPanel.classList.add('hidden')
    }
  })
}

// ── Send modal ──
function openSendModal(peerId) {
  activePeerId = peerId
  modalPeerName.textContent = `Send to ${peerLabel(peerId)}`
  fileInput.value = ''
  fileNameDisplay.textContent = 'Select file'
  sendBtn.disabled = true
  progressWrap.classList.add('hidden')
  progressFill.style.width = '0%'
  progressLabel.textContent = '0%'
  if (individualProgressFill) individualProgressFill.style.width = '0%'
  if (individualProgressLabel) individualProgressLabel.textContent = '0%'
  if (transferSpeed) transferSpeed.textContent = '0 B/s'
  resetSpeedTracker()
  clearPreviews()
  sendModal.classList.remove('hidden')
  setPendingRequestState(true)
}

function closeSendModal() {
  sendModal.classList.add('hidden')
  activePeerId = null
  fileInput.value = ''
  fileNameDisplay.textContent = 'Select file'
  if (transferSpeed) transferSpeed.textContent = '0 B/s'
  resetSpeedTracker()
  clearPreviews()
  setPendingRequestState(false)
}

cancelBtn.addEventListener('click', closeSendModal)

sendModal.addEventListener('click', (e) => {
  if (e.target === sendModal) closeSendModal()
})

// ── File input & Drag/Drop — only wire the input's change event, no manual .click() ──
fileInput.addEventListener('change', () => {
  const files = fileInput.files
  if (files && files.length === 1) {
    fileNameDisplay.textContent = files[0].name
    sendBtn.disabled = false
    renderFilePreviews(files)
  } else if (files && files.length > 1) {
    fileNameDisplay.textContent = `${files.length} files selected`
    sendBtn.disabled = false
    renderFilePreviews(files)
  } else {
    fileNameDisplay.textContent = 'Select file'
    sendBtn.disabled = true
    clearPreviews()
  }
})

if (filePickLabel) {
  filePickLabel.addEventListener('dragover', (e) => {
    e.preventDefault()
    filePickLabel.classList.add('drag-over')
  })

  filePickLabel.addEventListener('dragleave', () => {
    filePickLabel.classList.remove('drag-over')
  })

  filePickLabel.addEventListener('drop', (e) => {
    e.preventDefault()
    filePickLabel.classList.remove('drag-over')
    const files = e.dataTransfer.files
    if (files.length > 0) {
      fileInput.files = files
      // Trigger change manually
      const event = new Event('change')
      fileInput.dispatchEvent(event)
    }
  })
}

// Remove the redundant label click handler that was causing double open.
// The <label> in HTML wraps <input type="file"> so it already triggers it natively.

sendBtn.addEventListener('click', () => {
  const files = fileInput.files
  if (!files || files.length === 0 || !activePeerId) return

  sendBtn.disabled = true
  cancelBtn.disabled = true
  progressWrap.classList.remove('hidden')
  resetSpeedTracker()
  if (transferSpeed) transferSpeed.textContent = '0 B/s'

  try {
    fsp.sendFile(activePeerId, files, (progress) => {
      if (progress === -1) {
        // Declined!
        setStatus(`Transfer declined by ${peerLabel(activePeerId)}`)
        closeSendModal()
        cancelBtn.disabled = false
        sendBtn.disabled = false
        return
      }

      const { pct, currentFilePct, currentFileIndex, totalFiles, currentFileName, sentBytes } = progress

      if (totalFiles > 1) {
        if (aggregateProgressSection) {
          aggregateProgressSection.classList.remove('hidden')
        }
        const aggregateTitleEl = document.getElementById('aggregate-title')
        if (aggregateTitleEl) {
          aggregateTitleEl.textContent = `Overall Progress (${currentFileIndex + 1}/${totalFiles} files)`
        }
        if (progressFill) progressFill.style.width = `${pct}%`
        if (progressLabel) progressLabel.textContent = `${pct}%`

        if (individualFileTitle) {
          individualFileTitle.textContent = `File ${currentFileIndex + 1}: ${currentFileName}`
        }
        if (individualProgressFill) {
          individualProgressFill.style.width = `${currentFilePct || 0}%`
        }
        if (individualProgressLabel) {
          individualProgressLabel.textContent = `${currentFilePct || 0}%`
        }
      } else {
        if (aggregateProgressSection) {
          aggregateProgressSection.classList.add('hidden')
        }
        if (individualFileTitle) {
          individualFileTitle.textContent = `Sending: ${currentFileName}`
        }
        if (individualProgressFill) {
          individualProgressFill.style.width = `${currentFilePct || pct || 0}%`
        }
        if (individualProgressLabel) {
          individualProgressLabel.textContent = `${currentFilePct || pct || 0}%`
        }
      }

      if (transferSpeed) {
        transferSpeed.textContent = calculateSpeed(sentBytes || 0)
      }
      modalPeerName.textContent = `Sending ${currentFileIndex + 1} of ${totalFiles}: ${currentFileName}`

      if (pct === 100) {
        // Add to transfer history
        Array.from(files).forEach(f => {
          addTransferToHistory({
            name: f.name,
            size: f.size,
            direction: 'sent',
            data: f
          })
        })

        setTimeout(() => {
          closeSendModal()
          cancelBtn.disabled = false
          sendBtn.disabled = false
        }, 700)
      }
    })
  } catch (err) {
    setStatus('Send failed: ' + err.message)
    closeSendModal()
    cancelBtn.disabled = false
    sendBtn.disabled = false
  }
})

// ── Global Error & Status Notice Toast ──
function showToastNotice(msg) {
  let noticeEl = document.getElementById('global-toast-notice')
  if (!noticeEl) {
    noticeEl = document.createElement('div')
    noticeEl.id = 'global-toast-notice'
    noticeEl.style.position = 'fixed'
    noticeEl.style.bottom = '24px'
    noticeEl.style.right = '24px'
    noticeEl.style.zIndex = '9999'
    noticeEl.style.backgroundColor = 'var(--text)'
    noticeEl.style.color = 'var(--bg)'
    noticeEl.style.padding = '12px 18px'
    noticeEl.style.borderRadius = 'var(--radius-md)'
    noticeEl.style.fontSize = '13.5px'
    noticeEl.style.fontWeight = '500'
    noticeEl.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.2)'
    noticeEl.style.transition = 'all 0.3s ease'
    noticeEl.style.opacity = '0'
    noticeEl.style.transform = 'translateY(10px)'
    document.body.appendChild(noticeEl)
  }

  noticeEl.textContent = msg
  noticeEl.style.opacity = '1'
  noticeEl.style.transform = 'translateY(0)'

  if (window._noticeTimer) clearTimeout(window._noticeTimer)
  window._noticeTimer = setTimeout(() => {
    noticeEl.style.opacity = '0'
    noticeEl.style.transform = 'translateY(10px)'
  }, 4000)
}

// ── Receive toast elements ──
const toastActions = document.getElementById('toast-actions')
const toastProgressWrap = document.getElementById('toast-progress-wrap')
const toastProgressFill = document.getElementById('toast-progress-fill')
const toastProgressLabel = document.getElementById('toast-progress-label')

// ── Receive toast ──
function showReceiveToast(peerId, meta) {
  toastTitle.textContent = `Incoming from ${peerLabel(peerId)}`
  if (meta.filesCount > 1) {
    toastFile.textContent = `${meta.filesCount} files · ${formatBytes(meta.totalSize)}`
  } else {
    toastFile.textContent  = `${meta.name} · ${formatBytes(meta.size)}`
  }

  if (toastActions && toastProgressWrap) {
    toastActions.classList.remove('hidden')
    toastProgressWrap.classList.add('hidden')
    toastProgressFill.style.width = '0%'
    toastProgressLabel.textContent = '0%'
  }

  receiveToast.classList.remove('hidden')
  setPendingRequestState(true)
}

function hideReceiveToast() {
  receiveToast.classList.add('hidden')
  resetSpeedTracker()
  if (toastTransferSpeed) toastTransferSpeed.textContent = '0 B/s'
  setPendingRequestState(false)
}

acceptBtn.addEventListener('click', () => {
  fsp.acceptFile()
  resetSpeedTracker()
  if (toastTransferSpeed) toastTransferSpeed.textContent = '0 B/s'
  if (toastActions && toastProgressWrap) {
    toastActions.classList.add('hidden')
    toastProgressWrap.classList.remove('hidden')
    toastTitle.textContent = 'Preparing download...'
  } else {
    hideReceiveToast()
  }
})

declineBtn.addEventListener('click', () => {
  fsp.declineFile()
  hideReceiveToast()
})

// ── Helpers ──
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ── Init ──
const customUser = getCustomUsernameFromUrl()
const customPeerId = customUser ? `${customUser}_${Math.floor(Math.random() * 9000 + 1000)}` : null

const fsp = new FileSharePeer({
  peerId: customPeerId,
  onReady(id) {
    myPeerIdEl.textContent = peerLabel(id)
    const myProfileNameEl = document.getElementById('my-profile-name')
    if (myProfileNameEl) {
      myProfileNameEl.textContent = peerLabel(id)
    }
    const hash = window.location.hash.replace('#', '').trim()
    if (hash && hash !== 'internet') {
      setStatus(`Connected to Internet Room: ${hash}. Waiting for peers to join…`)
    } else if (hash === 'internet') {
      setStatus('Ready to connect. Create a new room or join an existing one.')
    } else {
      setStatus('Waiting for peers on your local network…')
    }
  },
  onPeerJoin(peerId) {
    addPeerNode(peerId)
  },
  onPeerLeave(peerId) {
    removePeerNode(peerId)
  },
  onFileOffer(peerId, meta) {
    showReceiveToast(peerId, meta)
  },
  onProgress(peerId, progressInfo) {
    if (progressInfo && progressInfo.direction === 'receive') {
      const { pct, currentFileIndex, totalFiles, currentFileName, receivedBytes } = progressInfo
      if (toastProgressFill && toastProgressLabel) {
        toastProgressFill.style.width = `${pct}%`
        toastProgressLabel.textContent = `${pct}%`
      }
      if (toastTransferSpeed) {
        toastTransferSpeed.textContent = calculateSpeed(receivedBytes || 0)
      }
      toastTitle.textContent = `Receiving ${currentFileIndex + 1} of ${totalFiles}`
      toastFile.textContent = currentFileName

      if (pct === 100) {
        setTimeout(() => {
          hideReceiveToast()
        }, 1000)
      }
    }
  },
  onError(msg) {
    setStatus('Status: ' + msg)
    showToastNotice(msg)
  },
  onFileReceived(peerId, fileInfo) {
    addTransferToHistory({
      name: fileInfo.name,
      size: fileInfo.size,
      direction: 'received',
      data: fileInfo.blob
    })
  }
})

// ── Internet Share Panel Controller ──
const shareBadge = document.getElementById('share-badge')
const shareTitle = document.getElementById('share-title')
const shareDesc = document.getElementById('share-desc')
const shareActionArea = document.getElementById('share-action-area')
const radarTitle = document.getElementById('radar-title')

function renderSharePanel() {
  const hash = window.location.hash.replace('#', '').trim()
  const isLobby = (hash === 'internet')
  const isActiveRoom = (hash && hash !== 'internet')
  
  const tabLocal = document.getElementById('tab-local')
  const tabInternet = document.getElementById('tab-internet')
  
  if (tabLocal && tabInternet) {
    if (hash) {
      tabLocal.classList.remove('active')
      tabInternet.classList.add('active')
      if (radarTitle) {
        if (isLobby) {
          radarTitle.textContent = 'Global Lobby'
        } else {
          radarTitle.textContent = 'Scanning Internet Room'
        }
      }
    } else {
      tabLocal.classList.add('active')
      tabInternet.classList.remove('active')
      if (radarTitle) radarTitle.textContent = 'Scanning Wi-Fi Network'
    }
    
    if (!tabLocal.dataset.wired) {
      tabLocal.dataset.wired = 'true'
      tabLocal.addEventListener('click', () => {
        if (window.location.hash) {
          window.location.hash = ''
          window.location.reload()
        }
      })
    }
    
    if (!tabInternet.dataset.wired) {
      tabInternet.dataset.wired = 'true'
      tabInternet.addEventListener('click', () => {
        if (!window.location.hash) {
          window.location.hash = 'internet'
          window.location.reload()
        }
      })
    }
  }
  
  if (isActiveRoom) {
    // We are in Internet / Active Room Mode
    shareBadge.textContent = 'Room Active'
    shareBadge.className = 'share-badge' // standard blue style
    shareTitle.textContent = 'Internet Share Active'
    shareDesc.textContent = 'Others on any internet connection can connect by visiting this exact URL. Share it to start transferring files.'
    
    // Create the input and copy button structure
    shareActionArea.innerHTML = `
      <div class="share-input-wrapper">
        <input type="text" id="share-url-input" readonly value="${window.location.href}" />
        <button id="copy-share-btn" class="btn-primary">Copy Link</button>
      </div>
      <div class="share-btn-row">
        <button id="leave-room-btn" class="btn-ghost">Leave Room</button>
      </div>
      <div id="copy-success-tip" class="success-tip hidden">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Copied to clipboard!</span>
      </div>
    `
    
    // Wire events
    const copyBtn = document.getElementById('copy-share-btn')
    const urlInput = document.getElementById('share-url-input')
    const successTip = document.getElementById('copy-success-tip')
    const leaveBtn = document.getElementById('leave-room-btn')
    
    copyBtn.addEventListener('click', () => {
      urlInput.select()
      urlInput.setSelectionRange(0, 99999) // for mobile
      navigator.clipboard.writeText(urlInput.value).then(() => {
        successTip.classList.remove('hidden')
        setTimeout(() => successTip.classList.add('hidden'), 3000)
      }).catch(err => {
        console.error('Failed to copy text: ', err)
      })
    })
    
    leaveBtn.addEventListener('click', () => {
      window.location.hash = ''
      window.location.reload()
    })
  } else if (isLobby) {
    // We are in Internet Setup / Lobby Mode
    shareBadge.textContent = 'Lobby'
    shareBadge.className = 'share-badge' // standard blue
    shareTitle.textContent = 'Global Connection Hub'
    shareDesc.textContent = 'Connect with any device worldwide. Generate a safe connection room or enter an existing one to join.'
    
    shareActionArea.innerHTML = `
      <div class="lobby-actions-grid">
        <div class="lobby-action-box">
          <h4>Option 1: Host a Room</h4>
          <p>Start a new room and share the link with others.</p>
          <button id="create-room-btn" class="btn-primary w-full">Create Share Room</button>
        </div>
        <div class="lobby-divider">or</div>
        <div class="lobby-action-box">
          <h4>Option 2: Join Existing Room</h4>
          <p>Enter the link or 8-character room code below.</p>
          <div class="join-input-group">
            <input type="text" id="join-room-input" placeholder="Paste link or room code..." />
            <button id="join-room-btn" class="btn-primary">Join</button>
          </div>
        </div>
        <div class="lobby-footer">
          <button id="back-to-local-btn" class="btn-ghost">Back to Local Wi-Fi Mode</button>
        </div>
      </div>
    `
    
    const createBtn = document.getElementById('create-room-btn')
    createBtn.addEventListener('click', () => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
      let randomCode = ''
      for (let i = 0; i < 8; i++) {
        randomCode += chars.charAt(Math.floor(Math.random() * chars.length))
      }
      window.location.hash = `room-${randomCode}`
      window.location.reload()
    })
    
    const joinBtn = document.getElementById('join-room-btn')
    const joinInput = document.getElementById('join-room-input')
    const handleJoin = () => {
      let val = joinInput.value.trim()
      if (!val) return
      
      // Parse the room code from URL if they pasted a link
      if (val.includes('#')) {
        val = val.split('#')[1]
      } else if (val.includes('/')) {
        try {
          const url = new URL(val)
          if (url.hash) val = url.hash.replace('#', '')
        } catch (e) {}
      }
      
      // Clean room name
      val = val.replace('room-', '')
      if (val) {
        window.location.hash = `room-${val}`
        window.location.reload()
      }
    }
    
    joinBtn.addEventListener('click', handleJoin)
    joinInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleJoin()
    })
    
    const backBtn = document.getElementById('back-to-local-btn')
    backBtn.addEventListener('click', () => {
      window.location.hash = ''
      window.location.reload()
    })
  } else {
    // We are in Local Network Mode
    shareBadge.textContent = 'Local Mode'
    shareBadge.className = 'share-badge local' // green style
    shareTitle.textContent = 'Local Network Discovery'
    shareDesc.textContent = "You're currently looking for other devices on your local Wi-Fi network. Need to share files with someone far away?"
    
    shareActionArea.innerHTML = `
      <div class="share-btn-row">
        <button id="switch-to-lobby-btn" class="btn-primary">Go to Global Internet Share</button>
      </div>
    `
    
    const switchBtn = document.getElementById('switch-to-lobby-btn')
    switchBtn.addEventListener('click', () => {
      window.location.hash = 'internet'
      window.location.reload()
    })
  }
}

// Initial render
renderSharePanel()

// ── Theme Switcher ──
const themeToggleBtn = document.getElementById('theme-toggle')
const themeMetaTag = document.querySelector('meta[name="theme-color"]')

function updateThemeMetaColor(isDark) {
  if (themeMetaTag) {
    themeMetaTag.setAttribute('content', isDark ? '#0b0f19' : '#2563eb')
  }
}

function initThemeToggle() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light'
  updateThemeMetaColor(currentTheme === 'dark')

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const activeTheme = document.documentElement.getAttribute('data-theme')
      const newTheme = activeTheme === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', newTheme)
      localStorage.setItem('boltdrop_theme', newTheme)
      updateThemeMetaColor(newTheme === 'dark')
    })
  }
}

initThemeToggle()
