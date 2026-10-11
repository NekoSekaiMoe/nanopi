// Right panel: Arkloop-style collapsible side drawer over the main column.
// Desktop: a static column toggled from the session header. Mobile: a fixed
// overlay with backdrop. Hosts session actions, the working directory, and the
// skills list (the sidebar keeps its own skills menu; this is quick access
// beside the conversation).

import { useEffect, useState } from 'preact/hooks';
import { getSkills, type SkillInfo } from '../api';
import { useT } from '../settings';

export interface RightPanelProps {
  open: boolean;
  onClose: () => void;
  cwd: string;
  onNew: () => void;
  onOpenCwd: () => void;
  onPickSkill: (name: string) => void;
}

export function RightPanel({ open, onClose, cwd, onNew, onOpenCwd, onPickSkill }: RightPanelProps) {
  const t = useT();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  // Load skills lazily the first time the panel opens; keep them cached.
  useEffect(() => {
    if (!open || skills) return;
    let cancelled = false;
    getSkills()
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills]);

  if (!open) return null;

  const dirName = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : '';

  return (
    <>
      <div class="right-panel-backdrop" onClick={onClose} />
      <aside class="right-panel" aria-label={t('panel.title')}>
        <section class="rp-section">
          <div class="rp-title">{t('panel.session')}</div>
          <button class="rp-row" onClick={onNew}>
            <span>{t('panel.newChat')}</span>
          </button>
          <button class="rp-row" onClick={onOpenCwd}>
            <span>{t('panel.changeDir')}</span>
          </button>
        </section>
        <section class="rp-section">
          <div class="rp-title">{t('panel.project')}</div>
          {dirName && <div class="rp-row" style="cursor: default;">{dirName}</div>}
          <div class="rp-desc">{cwd || t('header.noCwd')}</div>
        </section>
        <section class="rp-section">
          <div class="rp-title">{t('sidebar.skills')}</div>
          {skills === null && <div class="rp-desc">{t('sidebar.skillsLoading')}</div>}
          {skills !== null && skills.length === 0 && <div class="rp-desc">{t('sidebar.skillsEmpty')}</div>}
          {skills?.map((s) => (
            <button key={s.name} class="rp-row" title={s.description} onClick={() => onPickSkill(s.name)}>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{s.name}</span>
            </button>
          ))}
        </section>
      </aside>
    </>
  );
}
