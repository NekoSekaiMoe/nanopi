// Individual settings dialogs: theme, language, notifications.
// Model settings live in ./ModelProviders.
// Each is opened on its own from the sidebar settings menu.

import { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useSettings, Theme, FontScale } from '../settings';
import { Lang } from '../i18n';
import {
  loadPrefs,
  savePrefs,
  requestNotificationPermission,
  notificationsSupported,
  type NotificationPrefs,
} from '../lib/notifications';
import { fileToWallpaperDataUrl, setWallpaper } from '../lib/wallpaper';

/** Shared modal chrome for the settings dialogs. */
function SettingsModal({
  title,
  wide,
  cardClass,
  hideFooter,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  cardClass?: string;
  // 弹窗自带底部操作（如「添加模型」的 关闭/添加）时隐藏这里的页脚关闭，避免重复。
  hideFooter?: boolean;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const { t } = useSettings();
  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class={'modal-card' + (wide ? '' : ' modal-card-sm') + (cardClass ? ` ${cardClass}` : '')}>
        <div class="modal-header">
          <span>⚙</span>
          <h3>{title}</h3>
          <button class="ghost-btn modal-close" onClick={onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </div>
        <div class="modal-body">{children}</div>
        {!hideFooter && (
          <div class="modal-footer">
            <button class="btn" onClick={onClose}>
              {t('settings.close')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ThemeDialog({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, fontScale, setFontScale, t } = useSettings();
  const [wallpaperError, setWallpaperError] = useState(false);
  const options: { value: Theme; label: string }[] = [
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
    { value: 'system', label: t('settings.theme.system') },
  ];
  // Grouped with the theme rather than given a menu entry of its own: both
  // answer "how should this look", and one dialog keeps the sidebar short.
  const scales: { value: FontScale; label: string }[] = [
    { value: 'small', label: t('settings.fontScale.small') },
    { value: 'normal', label: t('settings.fontScale.normal') },
    { value: 'large', label: t('settings.fontScale.large') },
    { value: 'xlarge', label: t('settings.fontScale.xlarge') },
  ];
  return (
    <SettingsModal title={t('settings.menuTheme')} onClose={onClose}>
      <div class="field-group">
        <span class="modal-label">{t('settings.theme')}</span>
        <div class="segmented">
          {options.map((o) => (
            <button
              key={o.value}
              class={'segmented-btn' + (theme === o.value ? ' active' : '')}
              onClick={() => setTheme(o.value)}
              type="button"
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div class="field-group">
        <span class="modal-label">{t('settings.fontScale')}</span>
        <div class="segmented">
          {scales.map((o) => (
            <button
              key={o.value}
              class={'segmented-btn' + (fontScale === o.value ? ' active' : '')}
              onClick={() => setFontScale(o.value)}
              type="button"
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div class="field-group">
        <span class="modal-label">{t('settings.wallpaper')}</span>
        <div class="field-row">
          <button
            class="btn"
            type="button"
            onClick={() =>
              void (async () => {
                // Hidden input triggered from the button for consistent styling.
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  fileToWallpaperDataUrl(file)
                    .then((dataUrl) => {
                      setWallpaper(dataUrl);
                      setWallpaperError(false);
                    })
                    .catch(() => setWallpaperError(true));
                };
                input.click();
              })()
            }
          >
            {t('settings.wallpaperPick')}
          </button>
          <button class="btn" type="button" onClick={() => setWallpaper(null)}>
            {t('settings.wallpaperClear')}
          </button>
        </div>
        <div class="field-hint">
          {wallpaperError ? t('settings.wallpaperTooLarge') : t('settings.wallpaperHint')}
        </div>
      </div>
    </SettingsModal>
  );
}

export function LanguageDialog({ onClose }: { onClose: () => void }) {
  const { lang, setLang, t } = useSettings();
  const options: { value: Lang; label: string }[] = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ];
  return (
    <SettingsModal title={t('settings.menuLang')} onClose={onClose}>
      <div class="field-group">
        <span class="modal-label">{t('settings.language')}</span>
        <div class="segmented">
          {options.map((o) => (
            <button
              key={o.value}
              class={'segmented-btn' + (lang === o.value ? ' active' : '')}
              onClick={() => setLang(o.value)}
              type="button"
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </SettingsModal>
  );
}

export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useSettings();
  const supported = notificationsSupported();
  const [prefs, setPrefsState] = useState<NotificationPrefs>(() => loadPrefs());
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  function setPrefs(next: NotificationPrefs) {
    setPrefsState(next);
    savePrefs(next);
  }

  async function grantPermission() {
    const granted = await requestNotificationPermission();
    const actual: NotificationPermission =
      typeof Notification !== 'undefined'
        ? Notification.permission
        : granted
          ? 'granted'
          : 'denied';
    setPermission(actual);
    return actual;
  }

  // 用户手势内请求权限：开启开关时若尚未授权，先请求再落库。
  async function toggleEnabled() {
    if (!prefs.enabled && permission !== 'granted') {
      const actual = await grantPermission();
      if (actual !== 'granted') return; // 未授予则不开启，避免“开了但不弹”的静默失效。
    }
    setPrefs({ ...prefs, enabled: !prefs.enabled });
  }

  function setMinDurationSecs(v: string) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return;
    setPrefs({ ...prefs, minDurationSecs: Math.floor(n) });
  }

  return (
    <SettingsModal title={t('settings.notifications.title')} onClose={onClose}>
      <div class="field-group">
        {!supported && (
          <div class="field-hint">{t('settings.notifications.unsupported')}</div>
        )}
        <div class="field-row">
          <span class="modal-label">{t('settings.notifications.enabled')}</span>
          <input
            type="checkbox"
            checked={prefs.enabled}
            disabled={!supported}
            onChange={toggleEnabled}
          />
        </div>
        {prefs.enabled && supported && (
          <>
            <div class="field-row">
              <span class="modal-label">{t('settings.notifications.backgroundOnly')}</span>
              <input
                type="checkbox"
                checked={prefs.backgroundOnly}
                onChange={() => setPrefs({ ...prefs, backgroundOnly: !prefs.backgroundOnly })}
              />
            </div>
            <div class="field-row">
              <span class="modal-label">{t('settings.notifications.minDuration')}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={prefs.minDurationSecs}
                disabled={!prefs.enabled}
                onInput={(e) => setMinDurationSecs((e.target as HTMLInputElement).value)}
              />
            </div>
          </>
        )}
        <div class="field-hint">
          {permission === 'granted' && t('settings.notifications.permissionGranted')}
          {permission === 'default' && t('settings.notifications.permissionDefault')}
          {permission === 'denied' && t('settings.notifications.permissionDenied')}
        </div>
        {supported && permission === 'default' && (
          <button class="btn" type="button" onClick={() => void grantPermission()}>
            {t('settings.notifications.grantPermission')}
          </button>
        )}
      </div>
    </SettingsModal>
  );
}

/** 远程访问（蒲公英 / Oray PGY）：检测状态，给出可扫码的私网 URL。 */
