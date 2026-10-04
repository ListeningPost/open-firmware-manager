export class XRPCError extends Error {
  readonly status: number
  readonly error: string
  readonly xrpcMessage?: string
  readonly nsid?: string

  constructor(opts: {
    status: number
    error: string
    message?: string
    nsid?: string
  }) {
    super(opts.message ? `${opts.error}: ${opts.message}` : opts.error)
    this.name = 'XRPCError'
    this.status = opts.status
    this.error = opts.error
    this.xrpcMessage = opts.message
    this.nsid = opts.nsid
  }

  get isExpiredToken(): boolean {
    return this.error === 'ExpiredToken'
  }

  get isMissingRecord(): boolean {
    if (this.error === 'RecordNotFound' || this.status === 404) return true
    // Reference PDS often uses InvalidRequest: "Could not locate record: …"
    if (this.error === 'InvalidRequest') {
      const msg = this.xrpcMessage ?? this.message
      return /locate record|not found|no record/i.test(msg)
    }
    return false
  }

  static async fromResponse(res: Response, nsid?: string): Promise<XRPCError> {
    const text = await res.text()
    let error = 'Unknown'
    let message: string | undefined = text.slice(0, 500)
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      if (body.error) error = body.error
      if (body.message) message = body.message
    } catch {
      if (res.status === 401) error = 'InvalidToken'
      else if (res.status === 404) error = 'NotFound'
      else if (res.status === 429) error = 'RateLimitExceeded'
      else if (res.status === 413) error = 'PayloadTooLarge'
    }
    return new XRPCError({ status: res.status, error, message, nsid })
  }
}
