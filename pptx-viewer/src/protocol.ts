export type PrepareRequest = {
  sha256: string
  byteLength: number
  fileType?: string
}

export type PrepareResponse =
  | {
      status: 'ready'
      slideCount: number
      dpi: number
      engine: 'libreoffice'
      cached: boolean
      sourcePath?: string
      mimeType: string
    }
  | {
      status: 'need-upload'
      dpi: number
    }
  | {
      status: 'unavailable'
      reason: string
    }

export type UploadChunkRequest = {
  sha256: string
  index: number
  total: number
  b64: string
  fileType?: string
}

export type UploadChunkResponse = {
  received: number
  complete: boolean
}

export type ConvertUploadedRequest = {
  sha256: string
  fileType?: string
}

export type GetSlideChunkRequest = {
  sha256: string
  dpi: number
  slideIndex: number
  offset: number
  chunkSize: number
}

export type GetSlideChunkResponse = {
  b64: string
  totalBytes: number
  nextOffset: number
  done: boolean
  mimeType: string
}

declare module 'orca' {
  interface PluginRequests {
    'pptx.prepare': {
      input: PrepareRequest
      output: PrepareResponse
    }
    'pptx.uploadChunk': {
      input: UploadChunkRequest
      output: UploadChunkResponse
    }
    'pptx.convertUploaded': {
      input: ConvertUploadedRequest
      output: PrepareResponse
    }
    'pptx.getSlideChunk': {
      input: GetSlideChunkRequest
      output: GetSlideChunkResponse
    }
  }
}
