import React, { useState, useEffect, useRef } from 'react';
import { Clock, AlertTriangle, ArrowRight, RefreshCw, CheckCircle2, ShieldAlert, Sparkles, Volume2 } from 'lucide-react';
import { getUpcomingDatabaseSwitchInfo, isAutoScheduleEnabled, UpcomingSwitchInfo } from '../utils/databaseScheduler';
import { getActiveFirebaseConfig, switchActiveFirebaseConfig, syncFirebaseData } from '../clientFirebase';
import { FIREBASE_PRESETS } from '../firebasePresets';

interface DatabaseScheduleBannerProps {
  onDatabaseSwitched?: () => void;
}

export const DatabaseScheduleBanner: React.FC<DatabaseScheduleBannerProps> = ({ onDatabaseSwitched }) => {
  const [switchInfo, setSwitchInfo] = useState<UpcomingSwitchInfo | null>(null);
  const [autoEnabled, setAutoEnabled] = useState<boolean>(isAutoScheduleEnabled());
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);
  const [simulationSeconds, setSimulationSeconds] = useState<number | null>(null);
  const isSwitchingRef = useRef<boolean>(false);
  const lastWarnedLevel = useRef<string>('none');

  const activeConfig = getActiveFirebaseConfig();
  const activeProjectId = activeConfig?.projectId || 'banco-01-34be4';

  // Determine next target preset
  const currentIndex = FIREBASE_PRESETS.findIndex(p => p.config.projectId === activeProjectId);
  const nextPresetIndex = (currentIndex + 1) % FIREBASE_PRESETS.length;
  const simulatedNextPreset = FIREBASE_PRESETS[nextPresetIndex] || FIREBASE_PRESETS[0];

  const performSwitch = async (targetPresetConfig: any, targetName: string) => {
    if (isSwitchingRef.current) return;
    isSwitchingRef.current = true;
    setIsSyncing(true);

    try {
      console.log(`[DatabaseScheduler] Executando troca para ${targetName} (${targetPresetConfig.projectId})...`);
      
      // Sync current data to target
      try {
        await syncFirebaseData(activeConfig, targetPresetConfig);
      } catch (syncErr) {
        console.warn("[DatabaseScheduler] Erro na pré-sincronização:", syncErr);
      }

      const success = await switchActiveFirebaseConfig(targetPresetConfig);
      if (success) {
        setCompletedMessage(`Troca de Banco de Dados Concluída! Conectado ao ${targetName} (${targetPresetConfig.projectId}).`);
        if (onDatabaseSwitched) onDatabaseSwitched();

        setTimeout(() => {
          setCompletedMessage(null);
          window.location.reload();
        }, 1500);
      }
    } catch (err) {
      console.error("[DatabaseScheduler] Falha na troca de banco:", err);
    } finally {
      setIsSyncing(false);
      isSwitchingRef.current = false;
    }
  };

  // Event listener for simulation requests
  useEffect(() => {
    const handleSimulateEvent = (e: any) => {
      const seconds = e.detail?.seconds || 60;
      setSimulationSeconds(seconds);
    };

    window.addEventListener('trigger_db_simulated_countdown', handleSimulateEvent);
    return () => {
      window.removeEventListener('trigger_db_simulated_countdown', handleSimulateEvent);
    };
  }, []);

  // Countdown timer for simulation
  useEffect(() => {
    if (simulationSeconds === null) return;

    if (simulationSeconds <= 0) {
      setSimulationSeconds(null);
      performSwitch(simulatedNextPreset.config, simulatedNextPreset.name);
      return;
    }

    const simTimer = setInterval(() => {
      setSimulationSeconds(prev => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(simTimer);
  }, [simulationSeconds]);

  useEffect(() => {
    // Poll server active config every 3 seconds to keep multi-devices (PC & Mobile) synchronized
    const pollServerConfig = async () => {
      try {
        const res = await fetch('/api/firebase/config');
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.config && data.config.projectId) {
            const currentLocalConfig = getActiveFirebaseConfig();
            if (currentLocalConfig?.projectId !== data.config.projectId) {
              console.log(`[DatabaseScheduler] Servidor trocou para ${data.config.projectId}. Atualizando dispositivo...`);
              await switchActiveFirebaseConfig(data.config);
              window.location.reload();
            }
          }
        }
      } catch (e) {}
    };

    const pollTimer = setInterval(pollServerConfig, 3000);

    const checkSchedule = () => {
      const enabled = isAutoScheduleEnabled();
      setAutoEnabled(enabled);
      if (!enabled) {
        setSwitchInfo(null);
        return;
      }

      const info = getUpcomingDatabaseSwitchInfo(new Date());
      setSwitchInfo(info);

      // Play sound or log when warning level changes
      if (info.warningLevel !== lastWarnedLevel.current) {
        lastWarnedLevel.current = info.warningLevel;
        if (info.warningLevel !== 'none') {
          console.log(`[DatabaseScheduler] Warning Level: ${info.warningLevel} - ${info.remainingFormatted} remaining before switch to ${info.nextRule.name}`);
        }
      }

      // Check if trigger time reached
      if (info.shouldTriggerNow && !isSwitchingRef.current) {
        if (info.nextPreset && activeProjectId !== info.nextPreset.config.projectId) {
          performSwitch(info.nextPreset.config, info.nextRule.name);
        }
      }
    };

    checkSchedule();
    const timer = setInterval(checkSchedule, 1000);

    const handleSettingChange = (e: any) => {
      setAutoEnabled(e.detail);
      checkSchedule();
    };

    window.addEventListener('db_schedule_setting_changed', handleSettingChange);

    return () => {
      clearInterval(timer);
      clearInterval(pollTimer);
      window.removeEventListener('db_schedule_setting_changed', handleSettingChange);
    };
  }, [activeProjectId]);

  if ((!autoEnabled || !switchInfo) && simulationSeconds === null) {
    if (completedMessage) {
      return (
        <div className="bg-emerald-600 text-white px-4 py-2 text-xs font-bold font-mono flex items-center justify-between shadow-md animate-fade-in">
          <div className="flex items-center space-x-2 mx-auto">
            <CheckCircle2 className="h-4 w-4 text-emerald-200 animate-bounce" />
            <span>{completedMessage}</span>
          </div>
        </div>
      );
    }
    return null;
  }

  let warningLevel = switchInfo?.warningLevel || 'none';
  let remainingFormatted = switchInfo?.remainingFormatted || '00m 00s';
  let nextRuleName = switchInfo?.nextRule.name || simulatedNextPreset.name;
  let nextTimeLabel = switchInfo?.nextRule.timeLabel || 'Instantes';
  let nextPresetConfig = switchInfo?.nextPreset || simulatedNextPreset;

  if (simulationSeconds !== null) {
    if (simulationSeconds <= 60) {
      warningLevel = '1m';
    } else if (simulationSeconds <= 300) {
      warningLevel = '5m';
    } else {
      warningLevel = '10m';
    }
    const mins = Math.floor(simulationSeconds / 60);
    const secs = simulationSeconds % 60;
    remainingFormatted = `${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    nextRuleName = simulatedNextPreset.name;
    nextTimeLabel = 'Simulação';
    nextPresetConfig = simulatedNextPreset;
  }

  // Don't render banner if warning level is 'none' and countdown > 10m
  if (warningLevel === 'none' && simulationSeconds === null) {
    return null;
  }

  const handleManualTriggerNow = () => {
    if (nextPresetConfig) {
      performSwitch(nextPresetConfig.config || nextPresetConfig, nextRuleName);
    }
  };

  return (
    <div className="sticky top-0 z-50 font-sans shadow-lg animate-fade-in">
      {/* 10 MINUTE WARNING BANNER */}
      {warningLevel === '10m' && (
        <div className="bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 text-slate-950 px-4 py-3 text-xs font-medium flex flex-wrap items-center justify-between gap-3 border-b-2 border-amber-400 shadow-xl">
          <div className="flex items-start space-x-3 min-w-0 flex-1">
            <div className="bg-slate-950 text-amber-400 p-2 rounded-lg shrink-0 mt-0.5 shadow-md">
              <Clock className="h-5 w-5 animate-pulse" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-extrabold uppercase tracking-wider text-slate-950 text-xs bg-amber-400/90 px-2 py-0.5 rounded border border-amber-700/40 shadow-xs">
                  ⚠️ ATENÇÃO: TROCA AUTOMÁTICA DE BANCO DE DADOS EM INSTANTES
                </span>
                <span className="font-mono font-black text-slate-950 bg-amber-200 px-2 py-0.5 rounded text-xs border border-amber-600/50 shadow-xs">
                  Faltam {remainingFormatted} para a comutação
                </span>
              </div>
              <p className="text-slate-950 font-semibold text-xs leading-relaxed">
                Haverá a mudança do banco de dados para o <span className="font-bold underline text-slate-950">{nextRuleName}</span> às <span className="font-bold">{nextTimeLabel}</span>. 
                Se você estiver realizando alguma movimentação ou lançamento na plataforma neste intervalo, aguarde a conclusão da troca do banco de dados antes de continuar para evitar ter que refazer o procedimento.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0 ml-auto">
            <button
              onClick={handleManualTriggerNow}
              disabled={isSyncing}
              className="bg-slate-950 hover:bg-slate-900 text-amber-400 border border-amber-500/40 px-3.5 py-2 rounded-lg font-mono text-xs font-bold flex items-center space-x-1.5 cursor-pointer shadow-md transition-all active:scale-95 disabled:opacity-50"
            >
              {isSyncing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              <span>{isSyncing ? 'Sincronizando...' : 'Antecipar Troca Agora'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 5 MINUTE WARNING BANNER */}
      {warningLevel === '5m' && (
        <div className="bg-gradient-to-r from-orange-600 via-amber-600 to-orange-600 text-white px-4 py-3 text-xs font-medium flex flex-wrap items-center justify-between gap-3 border-b-2 border-orange-400 shadow-xl animate-pulse">
          <div className="flex items-start space-x-3 min-w-0 flex-1">
            <div className="bg-slate-950 text-orange-400 p-2 rounded-lg shrink-0 mt-0.5 shadow-md">
              <AlertTriangle className="h-5 w-5 text-orange-400 animate-bounce" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-extrabold uppercase tracking-wider text-amber-200 text-xs bg-slate-950/90 px-2 py-0.5 rounded border border-amber-400/40 shadow-xs">
                  ⏰ ATENÇÃO: TROCA DE BANCO DE DADOS EM 5 MINUTOS
                </span>
                <span className="font-mono font-black text-amber-200 bg-slate-950 px-2 py-0.5 rounded text-xs border border-amber-400/50 shadow-xs">
                  Faltam {remainingFormatted} para a comutação
                </span>
              </div>
              <p className="text-white font-medium text-xs leading-relaxed">
                Restam apenas 5 minutos para a transição para o <span className="font-bold underline text-amber-200">{nextRuleName}</span> (às <span className="font-bold">{nextTimeLabel}</span>). 
                Salve suas alterações ou aguarde o encerramento da troca do banco de dados para evitar retrabalhos na plataforma.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0 ml-auto">
            <button
              onClick={handleManualTriggerNow}
              disabled={isSyncing}
              className="bg-slate-900 hover:bg-slate-950 text-amber-300 border border-amber-400/60 px-3.5 py-2 rounded-lg font-mono text-xs font-bold flex items-center space-x-1.5 cursor-pointer shadow-md transition-all active:scale-95 disabled:opacity-50"
            >
              {isSyncing ? <RefreshCw className="h-4 w-4 animate-spin text-amber-400" /> : <RefreshCw className="h-4 w-4" />}
              <span>{isSyncing ? 'Sincronizando...' : 'Trocar Banco Agora'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 1 MINUTE URGENT WARNING BANNER */}
      {warningLevel === '1m' && (
        <div className="bg-red-950 text-white px-4 py-3.5 text-xs font-bold flex flex-wrap items-center justify-between gap-3 border-b-4 border-red-500 shadow-2xl animate-pulse">
          <div className="flex items-start space-x-3 min-w-0 flex-1">
            <div className="bg-red-600 text-white p-2 rounded-lg shrink-0 shadow-lg animate-ping mt-0.5">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black uppercase tracking-wider text-red-400 text-sm block">
                  🚨 ATENÇÃO: TROCA DE BANCO DE DADOS EM 1 MINUTO
                </span>
                <span className="font-mono font-black text-amber-300 bg-red-900 px-2.5 py-0.5 rounded text-sm border border-red-500 shadow-md">
                  Faltam {remainingFormatted}
                </span>
              </div>
              <span className="text-red-100 font-medium text-xs block leading-relaxed">
                A troca de banco de dados para o <span className="font-bold underline text-white">{nextRuleName}</span> ocorrerá em menos de 1 minuto! Por favor, suspenda qualquer cadastro ou movimentação e aguarde a troca ser finalizada.
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0 ml-auto">
            <button
              onClick={handleManualTriggerNow}
              disabled={isSyncing}
              className="bg-red-600 hover:bg-red-500 text-white border border-red-300 px-4 py-2 rounded-lg font-mono text-xs font-black flex items-center space-x-2 cursor-pointer shadow-lg transition-all active:scale-95 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Sincronizando Base...' : 'Efetuar Troca Agora'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
