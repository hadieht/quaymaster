import type { ChannelType, ChannelTypeInfo } from '@quaymaster/shared';
import type { NotificationChannel } from './channel.js';
import { discordChannel } from './channels/discord.js';
import { gotifyChannel } from './channels/gotify.js';
import { ntfyChannel } from './channels/ntfy.js';
import { slackChannel } from './channels/slack.js';
import { smtpChannel } from './channels/smtp.js';
import { telegramChannel } from './channels/telegram.js';
import { webhookChannel } from './channels/webhook.js';

export class ChannelRegistry {
  private readonly channels = new Map<ChannelType, NotificationChannel<unknown>>();

  register(channel: NotificationChannel<unknown>): this {
    if (this.channels.has(channel.type))
      throw new Error(`Channel type "${channel.type}" is already registered`);
    this.channels.set(channel.type, channel);
    return this;
  }

  get(type: string): NotificationChannel<unknown> | undefined {
    return this.channels.get(type as ChannelType);
  }

  list(): NotificationChannel<unknown>[] {
    return [...this.channels.values()];
  }

  info(): ChannelTypeInfo[] {
    return this.list().map((c) => ({ type: c.type, label: c.label, fields: c.fields }));
  }
}

export function defaultRegistry(): ChannelRegistry {
  return new ChannelRegistry()
    .register(webhookChannel)
    .register(ntfyChannel)
    .register(gotifyChannel)
    .register(discordChannel)
    .register(slackChannel)
    .register(telegramChannel)
    .register(smtpChannel);
}
