import type { MailOptions, OutboundRequest, Transport } from './channel.js';
import { OutboundHttp, resolveAllowed } from './outbound.js';

interface Mailer {
  sendMail(m: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
  close(): void;
}

/** Production transport: policy-enforcing HTTP client plus nodemailer (loaded lazily). */
export class DefaultTransport implements Transport {
  constructor(private readonly http: OutboundHttp = new OutboundHttp()) {}

  request(req: OutboundRequest): Promise<{ status: number }> {
    return this.http.request(req);
  }

  async sendMail(o: MailOptions): Promise<void> {
    // Resolve with the same address policy, then connect to the checked IP (TLS name kept).
    const ip = await resolveAllowed(o.host);
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: ip,
      port: o.port,
      secure: o.secure,
      ...(o.username ? { auth: { user: o.username, pass: o.password ?? '' } } : {}),
      tls: { servername: o.host },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
    }) as unknown as Mailer;
    try {
      await transporter.sendMail({ from: o.from, to: o.to, subject: o.subject, text: o.text });
    } finally {
      transporter.close();
    }
  }
}
