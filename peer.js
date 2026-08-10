// frontend/peer.js — native WebRTC, trickle ICE, automatic ICE restart & robust error handling

const CHUNK_SIZE = 64 * 1024
const DEFAULT_ROOM = 'filedrop-default-room'

function getSignalUrl() {
  const customUrl = localStorage.getItem('boltdrop_custom_signal_url')
  if (customUrl && customUrl.trim()) {
    let url = customUrl.trim()
    if (url.startsWith('http://')) url = url.replace('http://', 'ws://')
    if (url.startsWith('https://')) url = url.replace('https://', 'wss://')
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${url}`
    }
    if (!url.includes('/signal')) {
      url = url.replace(/\/$/, '') + '/signal'
    }
    return url
  }
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/signal`
}

function getRoomId() {
  return window.location.hash.replace('#', '').trim() || DEFAULT_ROOM
}

function genId() {
  const adj  = ['swift','calm','bold','keen','wise','fair','cool','warm']
  const noun = ['fox','kite','oak','reef','star','lake','wolf','bird']
  const n = Math.floor(Math.random() * 900 + 100)
  return `${adj[~~(Math.random()*adj.length)]}-${noun[~~(Math.random()*noun.length)]}-${n}`
}

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ],
  iceCandidatePoolSize: 10
}

export class FileSharePeer {
  constructor({ peerId, onReady, onPeerJoin, onPeerLeave, onFileOffer, onProgress, onError, onFileReceived }) {
    this.onReady     = onReady || (() => {})
    this.onPeerJoin  = onPeerJoin || (() => {})
    this.onPeerLeave = onPeerLeave || (() => {})
    this.onFileOffer = onFileOffer || (() => {})
    this.onProgress  = onProgress || (() => {})
    this.onError     = onError || (() => {})
    this.onFileReceived = onFileReceived || (() => {})

    this.myId            = peerId || genId()
    this.ws              = null
    this.heartbeatTimer  = null
    this.reconnectTimer  = null
    this.reconnectAttempts = 0
    this.lastPingResponse = Date.now()

    this.peerConns       = new Map()  // peerId → { pc, iceCandidateQueue, remoteDescSet, iceRestartAttempts, connTimeout }
    this.dataChannels    = new Map()
    this.pendingReceive  = null
    this._receiveBuffers = new Map()
    this.activeTransfers = new Map()  // peerId → { reader, file, onProgress, aborted }
    this.activeBatches   = new Map()  // peerId → { batchId, files, currentFileIndex, onProgress }
    this.receivedBatches = new Map()  // batchId → { batchId, files, accepted, currentFileIndex, totalSize }

    this._setupNetworkListeners()
    this._connect()
  }

  _setupNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('[network] browser back online')
      this.onError('Network restored. Reconnecting...')
      this.reconnectAttempts = 0
      this._connect()
    })

    window.addEventListener('offline', () => {
      console.warn('[network] browser offline')
      this.onError('Network connection lost. Waiting to reconnect...')
      this._stopHeartbeat()
      if (this.ws) {
        try { this.ws.close() } catch (e) {}
      }
    })

    window.addEventListener('hashchange', () => {
      console.log('[signal] Room hash changed to:', getRoomId())
      this.peerConns.forEach((entry) => {
        try { entry.pc.close() } catch (e) {}
      })
      this.peerConns.clear()
      if (this.ws) {
        try { this.ws.close() } catch (e) {}
      }
      this.reconnectAttempts = 0
      this._connect()
    })
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this.lastPingResponse = Date.now()

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Watchdog: If no pong or message in 35s, force reconnect
        if (Date.now() - this.lastPingResponse > 35000) {
          console.warn('[signal] Heartbeat lost. Forcing reconnection...')
          try { this.ws.close() } catch (e) {}
          return
        }

        try {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        } catch (e) {
          console.error('[signal] Ping send error:', e)
        }
      }
    }, 15000)
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  _scheduleReconnect() {
    this._stopHeartbeat()
    if (this.reconnectTimer) return

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 12000) + (Math.random() * 500)
    this.reconnectAttempts++
    console.log(`[signal] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect()
    }, delay)
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this._stopHeartbeat()
    const room = getRoomId()
    const signalBase = getSignalUrl()
    const separator = signalBase.includes('?') ? '&' : '?'
    const url  = `${signalBase}${separator}peerId=${encodeURIComponent(this.myId)}&room=${encodeURIComponent(room)}`
    
    console.log('[signal] Connecting to:', url)

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error('[signal] WebSocket instantiation failed:', err)
      this._scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[signal] Connected successfully')
      this.reconnectAttempts = 0
      this._startHeartbeat()
      this.onReady(this.myId)
    }

    this.ws.onmessage = async (event) => {
      this.lastPingResponse = Date.now()
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch (err) {
        console.error('[signal] Invalid JSON message:', err)
        return
      }

      if (msg.type === 'ping') {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'pong' }))
        }
        return
      }
      if (msg.type === 'pong') return

      console.log('[signal] Received:', msg.type, msg.from || '', msg.peers || '')

      try {
        if (msg.type === 'PEER_LIST') {
          for (const peerId of msg.peers) {
            console.log('[rtc] Creating offer for peer:', peerId)
            await this._createOffer(peerId)
          }
        } else if (msg.type === 'PEER_JOINED') {
          console.log('[signal] Peer joined:', msg.peerId)
        } else if (msg.type === 'PEER_LEFT') {
          this._removePeer(msg.peerId)
        } else if (msg.type === 'offer') {
          console.log('[rtc] Got offer from:', msg.from)
          await this._handleOffer(msg.from, msg.sdp)
        } else if (msg.type === 'answer') {
          console.log('[rtc] Got answer from:', msg.from)
          await this._handleAnswer(msg.from, msg.sdp)
        } else if (msg.type === 'ice') {
          await this._handleIce(msg.from, msg.candidate)
        }
      } catch (err) {
        console.error(`[signal] Error handling ${msg.type} from ${msg.from}:`, err)
      }
    }

    this.ws.onclose = (e) => {
      console.warn('[signal] Closed:', e.code, e.reason)
      this._stopHeartbeat()
      this._scheduleReconnect()
    }

    this.ws.onerror = (err) => {
      console.error('[signal] WebSocket error:', err)
      this._stopHeartbeat()
      this.onError('Signaling connection error. Reconnecting...')
    }
  }

  _signal(to, msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ ...msg, to }))
      } catch (e) {
        console.error('[signal] Send error:', e)
      }
    } else {
      console.warn('[signal] Cannot send message, WebSocket not open')
    }
  }

  // ── Create a new RTCPeerConnection with queuing & error resilience ──
  _createPC(peerId) {
    if (this.peerConns.has(peerId)) return this.peerConns.get(peerId)

    const pc = new RTCPeerConnection(RTC_CONFIG)
    const entry = {
      pc,
      iceCandidateQueue: [],
      remoteDescSet: false,
      iceRestartAttempts: 0,
      connTimeout: null
    }
    this.peerConns.set(peerId, entry)

    // Connection watchdog timer (18s timeout)
    entry.connTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        console.warn(`[rtc] Connection to ${peerId} timed out. Attempting ICE restart...`)
        this._triggerIceRestart(peerId)
      }
    }, 18000)

    // Send trickle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._signal(peerId, { type: 'ice', candidate: event.candidate })
      }
    }

    // Robust State Monitoring & Auto ICE Restart
    const handleStateChange = () => {
      const state = pc.connectionState || pc.iceConnectionState
      console.log(`[rtc] Peer ${peerId} state:`, state)

      if (state === 'connected') {
        if (entry.connTimeout) {
          clearTimeout(entry.connTimeout)
          entry.connTimeout = null
        }
        entry.iceRestartAttempts = 0
        this.onPeerJoin(peerId)
      } else if (state === 'failed' || state === 'disconnected') {
        if (entry.iceRestartAttempts < 2) {
          console.warn(`[rtc] Connection ${state} with ${peerId}. Triggering ICE Restart (${entry.iceRestartAttempts + 1}/2)...`)
          entry.iceRestartAttempts++
          this._triggerIceRestart(peerId)
        } else {
          console.error(`[rtc] Connection unrecoverable with ${peerId}`)
          this.onError(`Direct connection to peer failed.`)
          this._removePeer(peerId)
        }
      }
    }

    pc.onconnectionstatechange = handleStateChange
    pc.oniceconnectionstatechange = handleStateChange

    return entry
  }

  async _triggerIceRestart(peerId) {
    const entry = this.peerConns.get(peerId)
    if (!entry) return
    const { pc } = entry

    try {
      console.log('[rtc] Initiating ICE restart offer to', peerId)
      const offer = await pc.createOffer({ iceRestart: true })
      await pc.setLocalDescription(offer)
      this._signal(peerId, { type: 'offer', sdp: pc.localDescription.sdp })
    } catch (err) {
      console.error('[rtc] ICE restart failed for', peerId, err)
    }
  }

  async _createOffer(peerId) {
    const { pc } = this._createPC(peerId)

    try {
      const dc = pc.createDataChannel('filedrop', { ordered: true })
      this._bindDataChannel(dc, peerId)
      this.dataChannels.set(peerId, dc)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      console.log('[rtc] Sending offer to', peerId)
      this._signal(peerId, { type: 'offer', sdp: pc.localDescription.sdp })
    } catch (err) {
      console.error('[rtc] Create offer error:', err)
      this.onError('Failed to initiate WebRTC connection')
    }
  }

  async _handleOffer(peerId, sdp) {
    const entry = this._createPC(peerId)
    const { pc } = entry

    pc.ondatachannel = (event) => {
      console.log('[rtc] Got data channel from', peerId)
      const dc = event.channel
      this.dataChannels.set(peerId, dc)
      this._bindDataChannel(dc, peerId)
    }

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp })
      entry.remoteDescSet = true

      // Flush any queued ICE candidates
      for (const candidate of entry.iceCandidateQueue) {
        try { await pc.addIceCandidate(candidate) } catch (e) {}
      }
      entry.iceCandidateQueue = []

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      console.log('[rtc] Sending answer to', peerId)
      this._signal(peerId, { type: 'answer', sdp: pc.localDescription.sdp })
    } catch (err) {
      console.error('[rtc] Handle offer error:', err)
    }
  }

  async _handleAnswer(peerId, sdp) {
    const entry = this.peerConns.get(peerId)
    if (!entry) return
    const { pc } = entry

    try {
      await pc.setRemoteDescription({ type: 'answer', sdp })
      entry.remoteDescSet = true

      for (const candidate of entry.iceCandidateQueue) {
        try { await pc.addIceCandidate(candidate) } catch (e) {}
      }
      entry.iceCandidateQueue = []
    } catch (err) {
      console.error('[rtc] Handle answer error:', err)
    }
  }

  async _handleIce(peerId, candidate) {
    if (!candidate) return
    const entry = this.peerConns.get(peerId)
    if (!entry) return
    const { pc } = entry

    if (!entry.remoteDescSet) {
      entry.iceCandidateQueue.push(candidate)
    } else {
      try {
        await pc.addIceCandidate(candidate)
      } catch (e) {
        console.warn('[rtc] ICE candidate add failed:', e.message)
      }
    }
  }

  _bindDataChannel(dc, peerId) {
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      console.log('[dc] Data channel OPEN with', peerId)
    }

    dc.onclose = () => {
      console.warn('[dc] Data channel CLOSED with', peerId)
      this._cleanupPeerTransfers(peerId, 'Data channel closed')
    }

    dc.onerror = (err) => {
      console.error('[dc] Data channel ERROR:', err)
      this._cleanupPeerTransfers(peerId, 'Data channel error')
    }

    dc.onmessage = (event) => {
      this._handleFileMessage(peerId, event.data)
    }
  }

  _cleanupPeerTransfers(peerId, reason) {
    // Abort sender side transfers
    const transfer = this.activeTransfers.get(peerId)
    if (transfer) {
      transfer.aborted = true
      this.activeTransfers.delete(peerId)
    }

    const batch = this.activeBatches.get(peerId)
    if (batch) {
      this.activeBatches.delete(peerId)
      try { batch.onProgress(-1) } catch (e) {}
      this.onError(`Transfer aborted: ${reason}`)
    }

    // Clean receiver buffers
    const rxState = this._receiveBuffers.get(peerId)
    if (rxState) {
      this._receiveBuffers.delete(peerId)
      this.onError(`Receive interrupted: ${reason}`)
    }
  }

  // ── Robust File Transfer Mechanics ──

  sendFile(peerId, files, onProgress) {
    const fileList = (files instanceof FileList || Array.isArray(files)) ? Array.from(files) : [files]
    if (fileList.length === 0) return

    const dc = this.dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') {
      this.onError('Cannot send: Peer connection is not active')
      throw new Error('Not connected')
    }

    const batchId = Math.random().toString(36).substring(2, 11)
    
    this.activeBatches.set(peerId, {
      batchId,
      files: fileList,
      currentFileIndex: 0,
      onProgress
    })

    try {
      dc.send(JSON.stringify({
        type: 'BATCH_OFFER',
        batchId,
        files: fileList.map(f => ({ name: f.name, size: f.size, mime: f.type }))
      }))
    } catch (err) {
      console.error('[dc] Batch offer send error:', err)
      this.onError('Failed to send file offer')
    }
  }

  _sendBatchNextFile(peerId, batchId, index) {
    const batch = this.activeBatches.get(peerId)
    if (!batch || batch.batchId !== batchId) return

    batch.currentFileIndex = index
    const file = batch.files[index]
    const dc = this.dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') {
      this.onError('Data channel closed before sending file')
      return
    }

    try {
      dc.send(JSON.stringify({
        type: 'FILE_OFFER',
        batchId,
        fileIndex: index,
        name: file.name,
        size: file.size,
        mime: file.type
      }))
    } catch (e) {
      this.onError('Failed to start file transfer')
      return
    }

    let offset = 0
    const reader = new FileReader()

    const transfer = { reader, file, aborted: false }
    this.activeTransfers.set(peerId, transfer)

    try {
      dc.bufferedAmountLowThreshold = 128 * 1024 // 128KB threshold
    } catch (e) {}

    const readNext = () => {
      if (transfer.aborted) return
      
      // High backpressure guard (pause read if > 2MB buffered)
      if (dc.bufferedAmount > 2 * 1024 * 1024) {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null
          readNext()
        }
        return
      }
      
      try {
        const chunk = file.slice(offset, offset + CHUNK_SIZE)
        reader.readAsArrayBuffer(chunk)
      } catch (err) {
        console.error('[file] Read slice error:', err)
        this._abortTransfer(peerId, batchId, 'Disk read error')
      }
    }

    reader.onerror = (err) => {
      console.error('[file] FileReader error:', err)
      this._abortTransfer(peerId, batchId, 'Failed to read local file')
    }

    reader.onload = (e) => {
      if (transfer.aborted) return
      
      try {
        dc.send(e.target.result)
        offset += e.target.result.byteLength
        
        const totalSize = batch.files.reduce((sum, f) => sum + f.size, 0)
        let sentBytes = 0
        for (let i = 0; i < index; i++) {
          sentBytes += batch.files[i].size
        }
        sentBytes += offset
        const pct = Math.min(99, Math.round((sentBytes / totalSize) * 100))
        
        batch.onProgress({
          pct,
          currentFilePct: Math.min(99, Math.round((offset / file.size) * 100)),
          currentFileIndex: index,
          totalFiles: batch.files.length,
          currentFileName: file.name,
          sentBytes,
          totalSize
        })
        
        if (offset < file.size) {
          readNext()
        } else {
          dc.send(JSON.stringify({
            type: 'FILE_DONE',
            batchId,
            fileIndex: index
          }))
          this.activeTransfers.delete(peerId)
        }
      } catch (err) {
        console.error('[dc] Send error:', err)
        this._abortTransfer(peerId, batchId, 'Transfer channel interrupted')
      }
    }

    readNext()
  }

  _abortTransfer(peerId, batchId, reason) {
    const dc = this.dataChannels.get(peerId)
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify({ type: 'FILE_ABORT', batchId, reason }))
      } catch (e) {}
    }
    this._cleanupPeerTransfers(peerId, reason)
  }

  acceptFile() {
    if (!this.pendingReceive) return
    this.pendingReceive.resolve()
  }

  declineFile() {
    if (this.pendingReceive) {
      this.pendingReceive.reject()
    }
  }

  _triggerDownload(senderId, batchId) {
    const state = this._receiveBuffers.get(senderId)
    if (!state) return
    
    // Integrity check
    const totalReceived = state.chunks.reduce((sum, c) => sum + c.byteLength, 0)
    if (state.meta.size && totalReceived < state.meta.size) {
      console.error(`[file] Truncated file error: Expected ${state.meta.size}, got ${totalReceived}`)
      this.onError(`File "${state.meta.name}" was incomplete or corrupted.`)
      this._receiveBuffers.delete(senderId)
      return
    }

    const blob = new Blob(state.chunks, { type: state.meta.mime || 'application/octet-stream' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = state.meta.name; a.click()
    
    if (this.onFileReceived) {
      try {
        this.onFileReceived(senderId, {
          name: state.meta.name,
          size: blob.size,
          blob: blob
        })
      } catch (e) {
        console.error('Error in onFileReceived:', e)
      }
    }
    
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    this._receiveBuffers.delete(senderId)

    const rBatch = this.receivedBatches.get(batchId)
    if (rBatch) {
      if (rBatch.currentFileIndex === rBatch.files.length - 1) {
        this.receivedBatches.delete(batchId)
      }
    }
  }

  _handleFileMessage(peerId, data) {
    if (typeof data === 'string') {
      let msg
      try {
        msg = JSON.parse(data)
      } catch (err) {
        console.error('[dc] Non-JSON message on channel:', err)
        return
      }

      if (msg.type === 'BATCH_OFFER') {
        const totalSize = msg.files.reduce((sum, f) => sum + f.size, 0)
        this.receivedBatches.set(msg.batchId, {
          batchId: msg.batchId,
          files: msg.files,
          accepted: false,
          currentFileIndex: 0,
          totalSize
        })

        this.pendingReceive = {
          peerId,
          batchId: msg.batchId,
          meta: msg,
          resolve: () => {
            const rBatch = this.receivedBatches.get(msg.batchId)
            if (rBatch) rBatch.accepted = true
            const dc = this.dataChannels.get(peerId)
            if (dc && dc.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'BATCH_ACCEPTED', batchId: msg.batchId }))
            }
            this.pendingReceive = null
          },
          reject: () => {
            this.receivedBatches.delete(msg.batchId)
            const dc = this.dataChannels.get(peerId)
            if (dc && dc.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'BATCH_DECLINED', batchId: msg.batchId }))
            }
            this.pendingReceive = null
          }
        }

        this.onFileOffer(peerId, {
          batchId: msg.batchId,
          filesCount: msg.files.length,
          totalSize: totalSize,
          name: msg.files.length === 1 ? msg.files[0].name : `${msg.files.length} files`,
          size: totalSize
        })
        return
      }

      if (msg.type === 'BATCH_ACCEPTED') {
        const batch = this.activeBatches.get(peerId)
        if (batch && batch.batchId === msg.batchId) {
          this._sendBatchNextFile(peerId, msg.batchId, 0)
        }
        return
      }

      if (msg.type === 'BATCH_DECLINED') {
        const batch = this.activeBatches.get(peerId)
        if (batch && batch.batchId === msg.batchId) {
          this.activeBatches.delete(peerId)
          batch.onProgress(-1)
        }
        return
      }

      if (msg.type === 'FILE_OFFER') {
        const rBatch = this.receivedBatches.get(msg.batchId)
        if (rBatch && rBatch.accepted) {
          rBatch.currentFileIndex = msg.fileIndex
          this._receiveBuffers.set(peerId, {
            chunks: [],
            meta: msg,
            accepted: true,
            done: false
          })
        }
        return
      }

      if (msg.type === 'FILE_ABORT') {
        console.warn('[dc] Peer aborted transfer:', msg.reason)
        this.onError(`Transfer aborted by sender: ${msg.reason || 'Unknown reason'}`)
        this._receiveBuffers.delete(peerId)
        return
      }

      if (msg.type === 'FILE_DONE') {
        const rBatch = this.receivedBatches.get(msg.batchId)
        if (!rBatch) return

        const state = this._receiveBuffers.get(peerId)
        if (!state) return

        state.done = true
        this._triggerDownload(peerId, msg.batchId)

        const dc = this.dataChannels.get(peerId)
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            type: 'FILE_ACK',
            batchId: msg.batchId,
            fileIndex: msg.fileIndex
          }))
        }
        return
      }

      if (msg.type === 'FILE_ACK') {
        const batch = this.activeBatches.get(peerId)
        if (batch && batch.batchId === msg.batchId) {
          const nextIndex = msg.fileIndex + 1
          if (nextIndex < batch.files.length) {
            this._sendBatchNextFile(peerId, msg.batchId, nextIndex)
          } else {
            const totalSize = batch.files.reduce((sum, f) => sum + f.size, 0)
            batch.onProgress({
              pct: 100,
              currentFilePct: 100,
              currentFileIndex: msg.fileIndex,
              totalFiles: batch.files.length,
              currentFileName: batch.files[msg.fileIndex].name,
              sentBytes: totalSize,
              totalSize
            })
            this.activeBatches.delete(peerId)
          }
        }
        return
      }

    } else {
      // Incoming ArrayBuffer binary chunk
      const state = this._receiveBuffers.get(peerId)
      if (!state) return

      state.chunks.push(data)
      const received = state.chunks.reduce((a, c) => a + c.byteLength, 0)
      
      const rBatch = this.receivedBatches.get(state.meta.batchId)
      if (rBatch) {
        let receivedBatchBytes = 0
        for (let i = 0; i < rBatch.currentFileIndex; i++) {
          receivedBatchBytes += rBatch.files[i].size
        }
        receivedBatchBytes += received
        const pct = Math.round((receivedBatchBytes / rBatch.totalSize) * 100)
        
        this.onProgress(peerId, {
          pct,
          currentFileIndex: rBatch.currentFileIndex,
          totalFiles: rBatch.files.length,
          currentFileName: state.meta.name,
          direction: 'receive',
          receivedBytes: receivedBatchBytes,
          totalSize: rBatch.totalSize
        })
      }
    }
  }

  _removePeer(peerId) {
    const entry = this.peerConns.get(peerId)
    if (entry) {
      if (entry.connTimeout) clearTimeout(entry.connTimeout)
      try { entry.pc.close() } catch (e) {}
    }
    this.peerConns.delete(peerId)
    this.dataChannels.delete(peerId)
    this._receiveBuffers.delete(peerId)
    this.onPeerLeave(peerId)
  }
}
