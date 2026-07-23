import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, terminate, setLogLevel, writeBatch } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";

// Silence verbose or harmless Firestore warnings/info logs in browser
try {
  setLogLevel("silent");
} catch (e) {
  // ignore
}

// Shared DB keys for state tracking
const DB_KEYS = [
  "users", "drivers", "vehicles", "products", "activeAssets", 
  "audits", "vales", "returnForecasts", "fiscalAlerts", 
  "importedRoutes", "audit_logs", "customManual"
];

let firestoreInstance: any = null;
let isAuthenticating = false;
let isAuthenticated = false;
let clientAuthError: string | null = null;
let lastAuthAttemptTime = 0;
const AUTH_COOLDOWN_MS = 25000; // 25 seconds cooldown to prevent auth/too-many-requests loop
let lastSuccessfulSyncTime = 0;

export function getLastSuccessfulSyncTime(): number {
  return lastSuccessfulSyncTime;
}

let isFirestoreQuotaExceeded = false;
let hasClientPermissionError = false;

export function isPermissionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.code || err).toLowerCase();
  return (
    err.code === "permission-denied" ||
    msg.includes("missing or insufficient permissions") ||
    msg.includes("permission-denied") ||
    msg.includes("insufficient permissions")
  );
}

export function checkPermissionError(err: any) {
  if (err && isPermissionError(err)) {
    if (!hasClientPermissionError) {
      console.warn("[ClientFirebase] Permissões insuficientes no cliente Firestore. Ativando fallback transparente para servidor Express (/api/db)...");
      hasClientPermissionError = true;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event('client_firestore_permission_denied'));
      }
    }
  }
}

// Check localStorage on load for quota timestamp
if (typeof window !== "undefined") {
  const ts = localStorage.getItem('firestore_quota_exceeded_timestamp');
  if (ts) {
    const elapsed = Date.now() - Number(ts);
    // Quota resets daily, let's keep it active for 12 hours unless manually reset/retried
    if (elapsed < 12 * 60 * 60 * 1000) {
      isFirestoreQuotaExceeded = true;
      console.warn("[ClientFirebase] Carregado estado de cota do Firestore excedida do cache local.");
    } else {
      localStorage.removeItem('firestore_quota_exceeded_timestamp');
    }
  }
}

export function getIsFirestoreQuotaExceeded(): boolean {
  return isFirestoreQuotaExceeded;
}

export function setFirestoreQuotaExceeded(val: boolean) {
  isFirestoreQuotaExceeded = val;
  if (val) {
    if (typeof window !== 'undefined') {
      localStorage.setItem('firestore_quota_exceeded_timestamp', String(Date.now()));
      
      // Terminate active client-side instance to stop background retry loops/listeners
      if (firestoreInstance) {
        try {
          console.warn("[ClientFirebase] Encerrando instância ativa do Firestore devido ao limite de cota...");
          terminate(firestoreInstance).catch((e) => {
            console.warn("[ClientFirebase] Erro ao desligar Firestore:", e);
          });
        } catch (e) {
          console.warn("[ClientFirebase] Exceção ao desligar Firestore:", e);
        }
        firestoreInstance = null;
      }

      // Emit a custom event to notify components immediately
      window.dispatchEvent(new Event('firestore_quota_exceeded'));
    }
  } else {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('firestore_quota_exceeded_timestamp');
      window.dispatchEvent(new Event('firestore_quota_restored'));
    }
  }
}

export function isQuotaError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.code || err).toLowerCase();
  return (
    err.code === "resource-exhausted" ||
    msg.includes("quota exceeded") ||
    msg.includes("quota-exceeded") ||
    msg.includes("resource-exhausted") ||
    msg.includes("quota limit exceeded")
  );
}

function checkQuotaError(err: any) {
  if (err && isQuotaError(err)) {
    console.warn("[ClientFirebase] Cota do Firestore excedida detectada! Alternando para modo local...");
    setFirestoreQuotaExceeded(true);
  }
}

export function getClientAuthError(): string | null {
  return clientAuthError;
}

export function getFirebaseConnectionState(): 'connected' | 'connecting' | 'disconnected' {
  if (typeof window === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return 'disconnected';
  }
  
  const db = getClientFirestore();
  if (!db) {
    return 'disconnected';
  }
  
  // If we have a critical auth error that isn't bypassed by our public Firestore rules
  if (clientAuthError && !clientAuthError.includes("admin-restricted-operation") && !isAuthenticated) {
    return 'disconnected';
  }
  
  // If we are authenticated OR we are operating in Admin-Restricted-Operation public compatibility mode
  if (isAuthenticated || (clientAuthError && clientAuthError.includes("admin-restricted-operation"))) {
    return 'connected';
  }
  
  if (isAuthenticating) {
    return 'connecting';
  }
  
  return 'connecting';
}

function triggerAnonymousAuth() {
  const now = Date.now();
  if (now - lastAuthAttemptTime < AUTH_COOLDOWN_MS) {
    return;
  }
  
  try {
    const auth = getAuth();
    if (auth.currentUser) {
      isAuthenticated = true;
      return;
    }
    
    lastAuthAttemptTime = now;
    isAuthenticating = true;
    signInAnonymously(auth)
      .then((userCredential) => {
        console.log("[ClientFirebase] Autenticação anônima realizada com sucesso:", userCredential.user.uid);
        isAuthenticated = true;
        isAuthenticating = false;
        clientAuthError = null;
      })
      .catch((err) => {
        const errCode = err.code || err.message || "unknown";
        clientAuthError = errCode;
        isAuthenticating = false;
        
        if (errCode.includes("admin-restricted-operation")) {
          console.warn(
            "[ClientFirebase] ⚠️ Métodos de login anônimo estão desativados no console do Firebase.\n" +
            "👉 Operando em Modo de Compatibilidade Direct Schema (regras do Firestore abertas para sincronização sem login)."
          );
        } else if (errCode.includes("too-many-requests")) {
          console.warn("[ClientFirebase] ⚠️ Muitas requisições de autenticação enviadas. Cooldown ativo...");
        } else if (errCode.includes("network-request-failed")) {
          console.warn("[ClientFirebase] ⚠️ Conexão de rede falhou durante autenticação do Firebase. Operando com dados locais/servidor.", errCode);
        } else {
          console.warn("[ClientFirebase] Aviso na autenticação anônima do Firebase:", errCode);
        }
      });
  } catch (e) {
    console.warn("[ClientFirebase] Erro ao obter serviço de autenticação:", e);
    clientAuthError = "get_auth_failed";
  }
}

// Determine if we should connect directly to Firestore from the browser
export function isClientFirebaseActive(): boolean {
  if (typeof window === "undefined" || hasClientPermissionError) return false;
  
  try {
    // If we have a valid direct Firestore connection configured and working, use it everywhere!
    // This unifies the Google AI Studio container and GitHub Pages deployments
    // to share the exact same database and communicate in real-time across devices.
    const db = getClientFirestore();
    if (db) return true;
  } catch (e) {
    console.warn("[ClientFirebase] Erro ao validar conexao do Firestore:", e);
  }
  
  // Static host check fallback
  const isGitHub = window.location.hostname.includes("github.io") || 
                   window.location.hostname.includes("github.com") ||
                   window.location.href.includes("github");
                   
  return isGitHub;
}

// Subscribe to real-time updates directly from Firestore collection "app_state"
// Reconstructs chunked documents automatically to prevent physical 1MB limit issues
export function subscribeToFirestore(onUpdate: (db: any) => void): () => void {
  const db = getClientFirestore();
  if (!db || hasClientPermissionError) return () => {};

  console.log("[ClientFirebase] Inscrevendo para atualizações em tempo real (onSnapshot)...");

  try {
    const collRef = collection(db, "app_state");
    const unsubscribe = onSnapshot(collRef, (snapshot) => {
      try {
        lastSuccessfulSyncTime = Date.now();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('firestore_synced', { detail: { time: lastSuccessfulSyncTime } }));
        }

        const docMap: Record<string, any> = {};
        snapshot.forEach((doc) => {
          docMap[doc.id] = doc.data();
        });

        const combinedDb: any = {};
        for (const key of DB_KEYS) {
          const docData = docMap[key];
          if (docData) {
            if (docData.chunkCount !== undefined) {
              const chunkCount = docData.chunkCount;
              const chunks: any[] = [];
              let isChunkIncomplete = false;
              for (let i = 0; i < chunkCount; i++) {
                const chunkDoc = docMap[`${key}_chunk_${i}`];
                if (!chunkDoc) {
                  isChunkIncomplete = true;
                  break;
                }
                chunks[i] = chunkDoc.data || [];
              }
              if (!isChunkIncomplete) {
                combinedDb[key] = chunks.flat();
              } else {
                console.warn(`[ClientFirebase] Chunks para '${key}' incompletos no snapshot, buscando partes ausentes via getDoc...`);
                // Asynchronously recover missing chunks so we don't drop real-time route updates
                (async () => {
                  try {
                    const recoveredChunks: any[] = [];
                    for (let i = 0; i < chunkCount; i++) {
                      const cDoc = docMap[`${key}_chunk_${i}`];
                      if (cDoc) {
                        recoveredChunks[i] = cDoc.data || [];
                      } else {
                        const snap = await getDoc(doc(db, "app_state", `${key}_chunk_${i}`));
                        recoveredChunks[i] = snap.exists() ? (snap.data().data || []) : [];
                      }
                    }
                    const recovered = recoveredChunks.flat();
                    onUpdate({ [key]: recovered });
                  } catch (e) {
                    console.warn(`[ClientFirebase] Falha ao recuperar chunks ausentes para '${key}':`, e);
                  }
                })();
              }
            } else if (docData.data !== undefined) {
              combinedDb[key] = docData.data;
            } else {
              combinedDb[key] = docData;
            }
          }
        }
        
        onUpdate(combinedDb);
      } catch (innerErr) {
        console.warn("[ClientFirebase] Erro ao processar dados de snapshot do Firestore:", innerErr);
      }
    }, (error) => {
      if (isPermissionError(error)) {
        console.warn("[ClientFirebase] Inscrição client-side interrompida por falta de permissão no Firestore. Alternando para sincronização via servidor Express.");
        checkPermissionError(error);
      } else {
        console.warn("[ClientFirebase] Aviso na inscrição em tempo real do Firestore:", error?.message || error);
        checkQuotaError(error);
      }
    });

    return unsubscribe;
  } catch (err) {
    if (isPermissionError(err)) {
      checkPermissionError(err);
    } else {
      console.warn("[ClientFirebase] Aviso ao registrar onSnapshot no Firestore:", err);
      checkQuotaError(err);
    }
    return () => {};
  }
}

// Get or initialize the direct client Firestore instance
export function getClientFirestore() {
  if (isFirestoreQuotaExceeded || hasClientPermissionError) {
    return null;
  }
  if (firestoreInstance) {
    if (!isAuthenticated && !isAuthenticating) {
      triggerAnonymousAuth();
    }
    return firestoreInstance;
  }
  
  try {
    let config: any = null;
    
    // Check localStorage first
    if (typeof window !== "undefined") {
      const localCfg = localStorage.getItem('logiroute_firebase_client_config');
      if (localCfg) {
        try {
          config = JSON.parse(localCfg);
          console.log("[ClientFirebase] Carregada configuração do Firebase do localStorage.");
        } catch (e) {
          console.warn("[ClientFirebase] Falha ao analisar configuração do Firebase do localStorage:", e);
        }
      }
    }
    
    // Fallback to static applet config
    if (!config || !config.projectId) {
      config = firebaseConfig;
    }

    if (
      !config ||
      !config.projectId || 
      config.projectId === "remixed-project-id" ||
      config.projectId.includes("placeholder")
    ) {
      console.warn("[ClientFirebase] Configuração de Firebase vazia ou placeholder. Conexão direta ignorada.");
      return null;
    }

    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    const dbId = (config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)") ? config.firestoreDatabaseId : undefined;
    firestoreInstance = dbId ? getFirestore(app, dbId) : getFirestore(app);
    console.log("[ClientFirebase] Conexão direta com Firestore inicializada com sucesso!");
    
    // Trigger anonymous authentication immediately upon initialization
    triggerAnonymousAuth();
    
    return firestoreInstance;
  } catch (err) {
    console.warn("[ClientFirebase] Erro ao inicializar conexão direta com o Firestore:", err);
    return null;
  }
}

// Helper to chunk large arrays to prevent exceeding Firestore 1MB document limit
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Fetch all database records directly from Firebase Firestore (client-side SPA fallback)
export async function fetchDirectlyFromFirestore(): Promise<any> {
  const db = getClientFirestore();
  if (!db) return null;

  console.log("[ClientFirebase] Buscando dados diretamente do Firestore...");
  const combinedDb: any = {};

  try {
    const promises = DB_KEYS.map(async (key) => {
      const docRef = doc(db, "app_state", key);
      try {
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const docData = snap.data();
          if (docData && docData.chunkCount !== undefined) {
            const chunkCount = docData.chunkCount;
            const chunks: any[] = [];
            const chunkPromises = [];
            let hasChunkError = false;

            for (let i = 0; i < chunkCount; i++) {
              const chunkDocRef = doc(db, "app_state", `${key}_chunk_${i}`);
              const chunkPromise = getDoc(chunkDocRef).then((chunkSnap) => {
                if (chunkSnap.exists()) {
                  chunks[i] = chunkSnap.data().data || [];
                } else {
                  hasChunkError = true;
                }
              }).catch((chunkErr) => {
                console.warn(`[ClientFirebase] Erro ao carregar chunk ${i} de ${key}:`, chunkErr);
                hasChunkError = true;
              });
              chunkPromises.push(chunkPromise);
            }

            await Promise.all(chunkPromises);
            if (!hasChunkError) {
              combinedDb[key] = chunks.flat();
            }
          } else if (docData && docData.data !== undefined) {
            combinedDb[key] = docData.data;
          } else {
            combinedDb[key] = docData;
          }
        }
      } catch (err) {
        console.warn(`[ClientFirebase] Erro ao ler documento '${key}' do Firestore:`, err);
        if (isPermissionError(err)) {
          checkPermissionError(err);
        } else {
          checkQuotaError(err);
        }
      }
    });

    await Promise.all(promises);
    lastSuccessfulSyncTime = Date.now();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('firestore_synced', { detail: { time: lastSuccessfulSyncTime } }));
    }
    return combinedDb;
  } catch (e) {
    if (isPermissionError(e)) {
      checkPermissionError(e);
    } else {
      console.warn("[ClientFirebase] Falha ao ler do Firestore diretamente:", e);
      checkQuotaError(e);
    }
    return null;
  }
}

// Save database state directly to Firebase Firestore (client-side SPA fallback)
export async function saveDirectlyToFirestore(payload: any): Promise<boolean> {
  const db = getClientFirestore();
  if (!db) return false;

  console.log("[ClientFirebase] Sincronizando alterações diretamente com o Firestore...");

  try {
    const promises = Object.keys(payload).map(async (key) => {
      if (!DB_KEYS.includes(key)) return;

      const docRef = doc(db, "app_state", key);
      const rawData = payload[key];
      // Sanitize data to convert any undefined properties to omitted keys/nulls
      const cleanData = rawData !== undefined ? JSON.parse(JSON.stringify(rawData)) : [];

      if (Array.isArray(cleanData)) {
        const chunks = chunkArray(cleanData, 500);

        // Get old chunk count to delete orphaned chunks
        let oldChunkCount = 0;
        try {
          const controlSnap = await getDoc(docRef);
          if (controlSnap.exists()) {
            oldChunkCount = controlSnap.data().chunkCount || 0;
          }
        } catch (e) {
          // Ignore
        }

        // Use writeBatch for atomic update of chunks, control document, and cleanup
        const batch = writeBatch(db);

        chunks.forEach((chunk, i) => {
          const chunkDocRef = doc(db, "app_state", `${key}_chunk_${i}`);
          batch.set(chunkDocRef, { data: chunk });
        });

        // Save control document
        batch.set(docRef, { chunkCount: chunks.length });

        // Clean up old chunks atomically
        if (oldChunkCount > chunks.length) {
          for (let i = chunks.length; i < oldChunkCount; i++) {
            const obsoleteDocRef = doc(db, "app_state", `${key}_chunk_${i}`);
            batch.delete(obsoleteDocRef);
          }
        }

        await batch.commit();
      } else if (typeof cleanData === 'object' && cleanData !== null) {
        await setDoc(docRef, cleanData);
      } else {
        await setDoc(docRef, { data: cleanData });
      }
    });

    await Promise.all(promises);
    console.log("[ClientFirebase] Alterações persistidas no Firestore com sucesso!");
    return true;
  } catch (e) {
    if (isPermissionError(e)) {
      checkPermissionError(e);
    } else {
      console.warn("[ClientFirebase] Falha ao persistir alterações no Firestore:", e);
      checkQuotaError(e);
    }
    return false;
  }
}

// Get Gemini Key directly from Firestore
export async function getGeminiKeyFromFirestore(): Promise<string | null> {
  const db = getClientFirestore();
  if (!db) return null;
  try {
    const docRef = doc(db, "app_state", "gemini_config");
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      return data?.apiKey || null;
    }
  } catch (e) {
    if (isPermissionError(e)) {
      checkPermissionError(e);
    } else {
      console.warn("[ClientFirebase] Erro ao carregar chave do Gemini do Firestore:", e);
      checkQuotaError(e);
    }
  }
  return null;
}

// Save Gemini Key directly to Firestore
export async function saveGeminiKeyToFirestore(apiKey: string): Promise<boolean> {
  const db = getClientFirestore();
  if (!db) return false;
  try {
    const docRef = doc(db, "app_state", "gemini_config");
    await setDoc(docRef, { apiKey: apiKey });
    return true;
  } catch (e) {
    if (isPermissionError(e)) {
      checkPermissionError(e);
    } else {
      console.warn("[ClientFirebase] Erro ao salvar chave do Gemini no Firestore:", e);
      checkQuotaError(e);
    }
    return false;
  }
}

