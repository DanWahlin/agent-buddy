import streamDeck, {
  action, SingletonAction,
  type DidReceiveSettingsEvent, type KeyDownEvent, type WillAppearEvent, type WillDisappearEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
} from '@elgato/streamdeck';
import {settingsUrl} from './client.js';
import {Monitor, type KeySettings, type KeyUpdate} from './monitor.js';

const monitor = new Monitor({log: message => streamDeck.logger.warn(message)});
const updates = new Map<string, KeyUpdate>();

@action({UUID: 'com.agentbuddy.status.monitor'})
class AgentStatus extends SingletonAction<KeySettings> {
  override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
    this.watch(ev);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
    this.watch(ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
    monitor.remove(ev.action.id);
    updates.delete(ev.action.id);
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    const update = updates.get(ev.action.id);
    if (update) await streamDeck.ui.sendToPropertyInspector({event: 'status', message: update.message});
  }

  override async onSendToPlugin(ev: SendToPluginEvent<{event?: string}, KeySettings>): Promise<void> {
    if (ev.payload && typeof ev.payload === 'object' && 'event' in ev.payload
      && ev.payload.event === 'getStatus') {
      const update = updates.get(ev.action.id);
      if (update) await streamDeck.ui.sendToPropertyInspector({event: 'status', message: update.message});
    }
  }

  override async onKeyDown(ev: KeyDownEvent<KeySettings>): Promise<void> {
    try {
      await streamDeck.system.openUrl(settingsUrl(await monitor.connection(ev.payload.settings)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cannot open Agent Buddy Settings.';
      streamDeck.logger.warn(message);
      await ev.action.showAlert();
      await streamDeck.ui.sendToPropertyInspector({event: 'status', message});
    }
  }

  private watch(ev: WillAppearEvent<KeySettings> | DidReceiveSettingsEvent<KeySettings>): void {
    if (!ev.action.isKey()) return;
    const key = ev.action;
    monitor.add(key.id, ev.payload.settings, async update => {
      await key.setTitle('');
      await key.setImage(update.image);
      updates.set(key.id, update);
      if (streamDeck.ui.action?.id === key.id)
        await streamDeck.ui.sendToPropertyInspector({event: 'status', message: update.message});
    });
  }
}

streamDeck.actions.registerAction(new AgentStatus());
// This plugin supports Stream Deck 6.6 and does not request settings from the SDK.
streamDeck.settings.useLegacySettingsBehavior = true;
void streamDeck.connect().catch(() => {
  streamDeck.logger.error('Cannot connect to Stream Deck. Restart the Stream Deck app.');
});
