// frontend/peer.js — native WebRTC, trickle ICE with candidate queuing

const CHUNK_SIZE = 64 * 1024
const DEFAULT_ROOM = 'filedrop-default-room'
const SIGNAL_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/signal`

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
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' }
  ],
}

export class FileSharePeer {
  constructor({ peerId, onReady, onPeerJoin, onPeerLeave, onFileOffer, onProgress, onError, onFileReceived }) {
    this.onReady     = onReady
    this.onPeerJoin  = onPeerJoin
    this.onPeerLeave = onPeerLeave
    this.onFileOffer = onFileOffer
    this.onProgress  = onProgress
    this.onError     = onError
    this.onFileReceived = onFileReceived

    this.myId            = peerId || genId()
    this.ws              = null
    this.peerConns       = new Map()  // peerId → { pc, iceCandidateQueue, remoteDescSet }
    this.dataChannels    = new Map()
    this.pendingReceive  = null
    this._receiveBuffers = new Map()
    this.activeTransfers = new Map()  // peerId → { reader, file, onProgress, aborted }
    this.activeBatches   = new Map()  // peerId → { batchId, files, currentFileIndex, onProgress }
    this.receivedBatches = new Map()  // batchId → { batchId, files, accepted, currentFileIndex, totalSize }

    this._connect()
  }

  _connect() {
    const room = getRoomId()
    const url  = `${SIGNAL_URL}?peerId=${encodeURIComponent(this.myId)}&room=${encodeURIComponent(room)}`
    console.log('[signal] connecting to', url)
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[signal] connected')
      this.onReady(this.myId)
    }

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)
      console.log('[signal] received:', msg.type, msg.from || '', msg.peers || '')

      if (msg.type === 'PEER_LIST') {
        for (const peerId of msg.peers) {
          console.log('[rtc] creating offer for', peerId)
          await this._createOffer(peerId)
        }
      }

      if (msg.type === 'PEER_JOINED') {
        console.log('[signal] peer joined, waiting for their offer:', msg.peerId)
      }

      if (msg.type === 'PEER_LEFT') {
        this._removePeer(msg.peerId)
      }

      if (msg.type === 'offer') {
        console.log('[rtc] got offer from', msg.from)
        await this._handleOffer(msg.from, msg.sdp)
      }

      if (msg.type === 'answer') {
        console.log('[rtc] got answer from', msg.from)
        await this._handleAnswer(msg.from, msg.sdp)
      }

      if (msg.type === 'ice') {
        console.log('[rtc] got ICE from', msg.from, msg.candidate?.candidate?.split(' ')[7])
        await this._handleIce(msg.from, msg.candidate)
      }
    }

    this.ws.onclose = (e) => {
      console.log('[signal] closed', e.code, e.reason)
      setTimeout(() => this._connect(), 2000)
    }

    this.ws.onerror = () => {
      this.onError('Signaling connection failed')
    }
  }

  _signal(to, msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, to }))
    }
  }

  // ── Create a new RTCPeerConnection with queuing support ──
  _createPC(peerId) {
    if (this.peerConns.has(peerId)) return this.peerConns.get(peerId)

    const pc = new RTCPeerConnection(RTC_CONFIG)
    const entry = { pc, iceCandidateQueue: [], remoteDescSet: false }
    this.peerConns.set(peerId, entry)

    // Send ICE candidates as they arrive (trickle ICE)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[rtc] sending ICE to', peerId, event.candidate.candidate.split(' ')[7])
        this._signal(peerId, { type: 'ice', candidate: event.candidate })
      } else {
        console.log('[rtc] ICE gathering complete for', peerId)
      }
    }

    pc.onconnectionstatechange = () => {      
      console.log('[rtc] connection state with', peerId, ':', pc.connectionState)
      if (pc.connectionState === 'connected') {
        this.onPeerJoin(peerId)
      }
      if (pc.connectionState === 'failed') {
        console.log('[rtc] failed with', peerId)
        this._removePeer(peerId)
      }
      if (pc.connectionState === 'disconnected') {
        this._removePeer(peerId)
      }
    }

    pc.onsignalingstatechange = () => {
      console.log('[rtc] signaling state with', peerId, ':', pc.signalingState)
    }

    pc.onicegatheringstatechange = () => {
      console.log('[rtc] ICE gathering:', pc.iceGatheringState)
    }

    return entry
  }

  async _createOffer(peerId) {
    const { pc } = this._createPC(peerId)

    const dc = pc.createDataChannel('filedrop', { ordered: true })
    this._bindDataChannel(dc, peerId)
    this.dataChannels.set(peerId, dc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    console.log('[rtc] sending offer to', peerId)
    this._signal(peerId, { type: 'offer', sdp: pc.localDescription.sdp })
  }

  async _handleOffer(peerId, sdp) {
    const entry = this._createPC(peerId)
    const { pc } = entry

    pc.ondatachannel = (event) => {
      console.log('[rtc] got data channel from', peerId)
      const dc = event.channel
      this.dataChannels.set(peerId, dc)
      this._bindDataChannel(dc, peerId)
    }

    await pc.setRemoteDescription({ type: 'offer', sdp })
    entry.remoteDescSet = true

    // Flush any queued ICE candidates that arrived before remote desc
    console.log('[rtc] flushing', entry.iceCandidateQueue.length, 'queued ICE candidates')
    for (const candidate of entry.iceCandidateQueue) {
      try { await pc.addIceCandidate(candidate) } catch (e) {}
    }
    entry.iceCandidateQueue = []

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    console.log('[rtc] sending answer to', peerId)
    this._signal(peerId, { type: 'answer', sdp: pc.localDescription.sdp })
  }

  async _handleAnswer(peerId, sdp) {
    const entry = this.peerConns.get(peerId)
    if (!entry) return
    const { pc } = entry

    await pc.setRemoteDescription({ type: 'answer', sdp })
    entry.remoteDescSet = true

    // Flush any queued ICE candidates
    console.log('[rtc] flushing', entry.iceCandidateQueue.length, 'queued ICE candidates')
    for (const candidate of entry.iceCandidateQueue) {
      try { await pc.addIceCandidate(candidate) } catch (e) {}
    }
    entry.iceCandidateQueue = []
  }

  async _handleIce(peerId, candidate) {
    if (!candidate) return
    const entry = this.peerConns.get(peerId)
    if (!entry) return
    const { pc } = entry

    if (!entry.remoteDescSet) {
      // Queue it — remote description not set yet
      console.log('[rtc] queuing ICE candidate from', peerId)
      entry.iceCandidateQueue.push(candidate)
    } else {
      try {
        await pc.addIceCandidate(candidate)
      } catch (e) {
        console.log('[rtc] failed to add ICE candidate', e.message)
      }
    }
  }

  _bindDataChannel(dc, peerId) {
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      console.log('[dc] data channel open with', peerId)
    }

    dc.onclose = () => {
      console.log('[dc] data channel closed with', peerId)
    }

    dc.onmessage = (event) => {
      this._handleFileMessage(peerId, event.data)
    }
  }

  // ── File transfer ──

  sendFile(peerId, files, onProgress) {
    const fileList = (files instanceof FileList || Array.isArray(files)) ? Array.from(files) : [files]
    if (fileList.length === 0) return

    const dc = this.dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') throw new Error('Not connected')

    const batchId = Math.random().toString(36).substring(2, 11)
    
    this.activeBatches.set(peerId, {
      batchId,
      files: fileList,
      currentFileIndex: 0,
      onProgress
    })

    dc.send(JSON.stringify({
      type: 'BATCH_OFFER',
      batchId,
      files: fileList.map(f => ({ name: f.name, size: f.size, mime: f.type }))
    }))
  }

  _sendBatchNextFile(peerId, batchId, index) {
    const batch = this.activeBatches.get(peerId)
    if (!batch || batch.batchId !== batchId) return

    batch.currentFileIndex = index
    const file = batch.files[index]
    const dc = this.dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') return

    dc.send(JSON.stringify({
      type: 'FILE_OFFER',
      batchId,
      fileIndex: index,
      name: file.name,
      size: file.size,
      mime: file.type
    }))

    let offset = 0
    const reader = new FileReader()

    const transfer = { reader, file, aborted: false }
    this.activeTransfers.set(peerId, transfer)

    try {
      dc.bufferedAmountLowThreshold = 65536 // 64KB
    } catch (e) {
      console.warn('[dc] bufferedAmountLowThreshold not supported', e)
    }

    const readNext = () => {
      if (transfer.aborted) return
      
      if (dc.bufferedAmount > 1024 * 1024) {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null
          readNext()
        }
        return
      }
      
      const chunk = file.slice(offset, offset + CHUNK_SIZE)
      reader.readAsArrayBuffer(chunk)
    }

    reader.onload = (e) => {
      if (transfer.aborted) return
      
      try {
        dc.send(e.target.result)
        offset += e.target.result.byteLength
        
        // Calculate total progress across the whole batch
        const totalSize = batch.files.reduce((sum, f) => sum + f.size, 0)
        let sentBytes = 0
        for (let i = 0; i < index; i++) {
          sentBytes += batch.files[i].size
        }
        sentBytes += offset
        const pct = Math.round((sentBytes / totalSize) * 100)
        
        batch.onProgress({
          pct,
          currentFilePct: Math.round((offset / file.size) * 100),
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
        console.error('[dc] send error:', err)
        this.activeTransfers.delete(peerId)
        this.activeBatches.delete(peerId)
        this.onError('Send failed: ' + err.message)
      }
    }

    readNext()
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
        console.error('Error calling onFileReceived:', e)
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
      const msg = JSON.parse(data)

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
    if (entry) entry.pc.close()
    this.peerConns.delete(peerId)
    this.dataChannels.delete(peerId)
    this._receiveBuffers.delete(peerId)
    this.onPeerLeave(peerId)
  }
}