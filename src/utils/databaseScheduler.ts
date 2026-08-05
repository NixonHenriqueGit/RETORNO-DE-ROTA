import { FIREBASE_PRESETS, FirebasePreset } from '../firebasePresets';

export interface ScheduleRule {
  id: string;
  presetId: string;
  name: string;
  badge: string;
  badgeColor: string;
  triggerHour: number;   // 0 - 23
  triggerMinute: number; // 0 - 59
  timeLabel: string;     // e.g. "07:00"
  description: string;   // e.g. "Turno Diurno (07:00 às 17:00)"
}

export const DEFAULT_SCHEDULE_RULES: ScheduleRule[] = [
  {
    id: "diurno_banco_01",
    presetId: "banco-01",
    name: "Banco 01 (Diurno)",
    badge: "07:00 - Banco 01",
    badgeColor: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    triggerHour: 7,
    triggerMinute: 0,
    timeLabel: "07:00",
    description: "Turno Diurno (07:00 às 17:00) ➔ Banco 01"
  },
  {
    id: "vespertino_banco_02",
    presetId: "banco-02",
    name: "Banco 02 (Vespertino)",
    badge: "17:00 - Banco 02",
    badgeColor: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    triggerHour: 17,
    triggerMinute: 0,
    timeLabel: "17:00",
    description: "Turno Vespertino (17:00 às 20:00) ➔ Banco 02"
  },
  {
    id: "noturno_banco_03",
    presetId: "banco-03",
    name: "Banco 03 (Noturno)",
    badge: "20:00 - Banco 03",
    badgeColor: "bg-indigo-500/15 text-indigo-600 border-indigo-500/30",
    triggerHour: 20,
    triggerMinute: 0,
    timeLabel: "20:00",
    description: "Turno Noturno (20:00 às 07:00) ➔ Banco 03"
  }
];

export function isAutoScheduleEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = localStorage.getItem('db_schedule_auto_enabled');
  return stored === null ? true : stored === 'true';
}

export function setAutoScheduleEnabled(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('db_schedule_auto_enabled', enabled ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent('db_schedule_setting_changed', { detail: enabled }));
  }
}

/**
 * Returns which preset SHOULD be active right now according to schedule
 */
export function getCurrentScheduledPresetId(now = new Date()): string {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // 07:00 = 420 mins, 17:00 = 1020 mins, 20:00 = 1200 mins
  if (currentMinutes >= 420 && currentMinutes < 1020) {
    return "banco-01"; // 07:00 - 16:59 -> Banco 01
  } else if (currentMinutes >= 1020 && currentMinutes < 1200) {
    return "banco-02"; // 17:00 - 19:59 -> Banco 02
  } else {
    return "banco-03"; // 20:00 - 06:59 -> Banco 03
  }
}

export interface UpcomingSwitchInfo {
  currentPresetId: string;
  nextRule: ScheduleRule;
  nextPreset: FirebasePreset | undefined;
  nextSwitchDate: Date;
  remainingSeconds: number;
  remainingFormatted: string;
  warningLevel: '10m' | '5m' | '1m' | 'none';
  shouldTriggerNow: boolean;
}

export function getUpcomingDatabaseSwitchInfo(now = new Date()): UpcomingSwitchInfo {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  // Sort rules by time in day
  // 07:00 (420), 17:00 (1020), 20:00 (1200)
  let nextRule: ScheduleRule;
  let nextSwitchDate = new Date(now);

  if (currentMinutes < 420) {
    // Before 07:00 -> Next is 07:00 today (banco-01)
    nextRule = DEFAULT_SCHEDULE_RULES[0]; // 07:00
    nextSwitchDate.setHours(7, 0, 0, 0);
  } else if (currentMinutes < 1020) {
    // 07:00 to 16:59 -> Next is 17:00 today (banco-02)
    nextRule = DEFAULT_SCHEDULE_RULES[1]; // 17:00
    nextSwitchDate.setHours(17, 0, 0, 0);
  } else if (currentMinutes < 1200) {
    // 17:00 to 19:59 -> Next is 20:00 today (banco-03)
    nextRule = DEFAULT_SCHEDULE_RULES[2]; // 20:00
    nextSwitchDate.setHours(20, 0, 0, 0);
  } else {
    // After 20:00 -> Next is 07:00 tomorrow (banco-01)
    nextRule = DEFAULT_SCHEDULE_RULES[0]; // 07:00
    nextSwitchDate.setDate(nextSwitchDate.getDate() + 1);
    nextSwitchDate.setHours(7, 0, 0, 0);
  }

  const diffMs = nextSwitchDate.getTime() - now.getTime();
  const remainingSeconds = Math.max(0, Math.floor(diffMs / 1000));

  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  
  let remainingFormatted = `${mins}m ${secs.toString().padStart(2, '0')}s`;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    remainingFormatted = `${hrs}h ${remMins}m`;
  }

  let warningLevel: '10m' | '5m' | '1m' | 'none' = 'none';
  if (remainingSeconds <= 60 && remainingSeconds > 0) {
    warningLevel = '1m';
  } else if (remainingSeconds <= 300 && remainingSeconds > 60) {
    warningLevel = '5m';
  } else if (remainingSeconds <= 600 && remainingSeconds > 300) {
    warningLevel = '10m';
  }

  const currentPresetId = getCurrentScheduledPresetId(now);
  const nextPreset = FIREBASE_PRESETS.find(p => p.id === nextRule.presetId || p.config.projectId === nextRule.presetId) || FIREBASE_PRESETS[0];

  return {
    currentPresetId,
    nextRule,
    nextPreset,
    nextSwitchDate,
    remainingSeconds,
    remainingFormatted,
    warningLevel,
    shouldTriggerNow: remainingSeconds <= 0
  };
}

export async function triggerGlobalDatabaseSwitch(
  seconds = 60,
  targetPresetId?: string,
  requestedBy?: string,
  requestedType: 'manual' | 'auto' = 'manual'
) {
  try {
    const activeConfig = localStorage.getItem('active_firebase_config');
    let activeProjectId = 'banco-01-34be4';
    if (activeConfig) {
      try {
        const parsed = JSON.parse(activeConfig);
        if (parsed.projectId) activeProjectId = parsed.projectId;
      } catch (e) {}
    }

    const currentIndex = FIREBASE_PRESETS.findIndex(p => p.config.projectId === activeProjectId);
    const nextIndex = (currentIndex + 1) % FIREBASE_PRESETS.length;
    const nextPreset = FIREBASE_PRESETS.find(p => p.id === targetPresetId || p.config.projectId === targetPresetId) || FIREBASE_PRESETS[nextIndex] || FIREBASE_PRESETS[0];

    const requesterText = requestedBy || 'Gestor Administrador';

    // Trigger on server so all PCs and Mobiles receive it via SSE/polling
    await fetch('/api/firebase/trigger-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetPresetId: nextPreset.id,
        targetConfig: nextPreset.config,
        targetName: nextPreset.name,
        countdownSeconds: seconds,
        requestedBy: requesterText,
        requestedType
      })
    });

    // Also dispatch local event for instant UI reaction
    window.dispatchEvent(new CustomEvent('trigger_db_simulated_countdown', {
      detail: {
        seconds,
        targetPreset: nextPreset,
        requestedBy: requesterText,
        requestedType
      }
    }));
  } catch (err) {
    console.error('Error triggering global db switch:', err);
  }
}
