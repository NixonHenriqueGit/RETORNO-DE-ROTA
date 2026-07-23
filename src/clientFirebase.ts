import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection, onSnapshot, terminate, setLogLevel, writeBatch } from "firebase/firestore";
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

const COLLECTION_MAP: Record<string, string> = {
  users: "users",
  drivers: "drivers",
  vehicles: "vehicles",
  products: "products",
  activeAssets: "activeAssets",
  audits: "audits",
  vales: "vales",
  returnForecasts: "returnForecasts",
  fiscalAlerts: "fiscalAlerts",
  importedRoutes: "importedRoutes",
  audit_logs: "auditLogs",
  auditLogs: "auditLogs",
  customManual: "customManual"
};

const TRACKED_COLLECTIONS = [
  "users",
  "drivers",
  "vehicles",
  "products",
  "activeAssets",
  "audits",
  "vales",
  "returnForecasts",
  "fiscalAlerts",
  "importedRoutes",
  "auditLogs",
  "customManual"
];

export function getItemDocId(item: any): string {
  if (!item) return `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  if (item.id !== undefined && item.id !== null && String(item.id).trim() !== "") {
    return String(item.id).trim();
  }
  if (item.code !== undefined && item.code !== null && String(item.code).trim() !== "") {
    return String(item.code).trim();
  }
  if (item.plate !== undefined && item.plate !== null && String(item.plate).trim() !== "") {
    return String(item.plate).trim();
  }
  if (item.username !== undefined && item.username !== null && String(item.username).trim() !== "") {
    return String(item.username).trim();
  }
  if (item.routeMap !== undefined && item.routeMap !== null && String(item.routeMap).trim() !== "") {
    const rDate = item.routeDate ? `_${item.routeDate}` : "";
    return `${String(item.routeMap).trim()}${rDate}`;
  }
  return `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

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

// Subscribe to real-time updates directly from individual Firestore collections (Armazém Fácil pattern)
export function subscribeToFirestore(onUpdate: (db: any) => void): () => void {
  const db = getClientFirestore();
  if (!db || hasClientPermissionError) return () => {};

  console.log("[ClientFirebase] Inscrevendo para atualizações em tempo real nas coleções do Firestore (modo Armazém Fácil)...");

  const combinedDb: Record<string, any> = {
    users: [],
    drivers: [],
    vehicles: [],
    products: [],
    activeAssets: [],
    audits: [],
    vales: [],
    returnForecasts: [],
    fiscalAlerts: [],
    importedRoutes: [],
    audit_logs: [],
    auditLogs: [],
    customManual: ""
  };

  const unsubscribes: (() => void)[] = [];

  TRACKED_COLLECTIONS.forEach((colName) => {
    try {
      if (colName === "customManual") {
        const docRef = doc(db, "customManual", "main");
        const unsub = onSnapshot(docRef, (docSnap) => {
          lastSuccessfulSyncTime = Date.now();
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent('firestore_synced', { detail: { time: lastSuccessfulSyncTime } }));
          }
          if (docSnap.exists()) {
            const data = docSnap.data();
            combinedDb.customManual = data.html || data.content || "";
          } else {
            combinedDb.customManual = "";
          }
          onUpdate({ ...combinedDb });
        }, (error) => {
          handleSubscriptionError(error);
        });
        unsubscribes.push(unsub);
      } else {
        const collRef = collection(db, colName);
        const unsub = onSnapshot(collRef, (snapshot) => {
          lastSuccessfulSyncTime = Date.now();
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent('firestore_synced', { detail: { time: lastSuccessfulSyncTime } }));
          }

          const items = snapshot.docs.map((d) => ({
            id: d.id,
            ...d.data()
          }));

          if (colName === "auditLogs") {
            combinedDb.auditLogs = items;
            combinedDb.audit_logs = items;
          } else {
            combinedDb[colName] = items;
          }

          onUpdate({ ...combinedDb });
        }, (error) => {
          handleSubscriptionError(error);
        });
        unsubscribes.push(unsub);
      }
    } catch (err) {
      handleSubscriptionError(err);
    }
  });

  return () => {
    unsubscribes.forEach((unsub) => {
      try {
        unsub();
      } catch (e) {
        // ignore
      }
    });
  };
}

function handleSubscriptionError(error: any) {
  if (isPermissionError(error)) {
    console.warn("[ClientFirebase] Inscrição client-side interrompida por falta de permissão no Firestore. Alternando para servidor Express.");
    checkPermissionError(error);
  } else {
    console.warn("[ClientFirebase] Aviso na inscrição em tempo real do Firestore:", error?.message || error);
    checkQuotaError(error);
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

// Fetch all database records directly from Firebase Firestore collections
export async function fetchDirectlyFromFirestore(): Promise<any> {
  const db = getClientFirestore();
  if (!db) return null;

  console.log("[ClientFirebase] Buscando dados diretamente das coleções do Firestore...");
  const combinedDb: Record<string, any> = {
    users: [],
    drivers: [],
    vehicles: [],
    products: [],
    activeAssets: [],
    audits: [],
    vales: [],
    returnForecasts: [],
    fiscalAlerts: [],
    importedRoutes: [],
    audit_logs: [],
    auditLogs: [],
    customManual: ""
  };

  try {
    const promises = TRACKED_COLLECTIONS.map(async (colName) => {
      try {
        if (colName === "customManual") {
          const docRef = doc(db, "customManual", "main");
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const data = snap.data();
            combinedDb.customManual = data.html || data.content || "";
          }
        } else {
          const collRef = collection(db, colName);
          const snap = await getDocs(collRef);
          const items = snap.docs.map((d) => ({
            id: d.id,
            ...d.data()
          }));
          if (colName === "auditLogs") {
            combinedDb.auditLogs = items;
            combinedDb.audit_logs = items;
          } else {
            combinedDb[colName] = items;
          }
        }
      } catch (err) {
        console.warn(`[ClientFirebase] Erro ao ler coleção '${colName}' do Firestore:`, err);
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

// Save database state directly to Firebase Firestore collections document-by-document
export async function saveDirectlyToFirestore(payload: any): Promise<boolean> {
  const db = getClientFirestore();
  if (!db) return false;

  console.log("[ClientFirebase] Sincronizando alterações documento por documento com o Firestore...");

  try {
    const keys = Object.keys(payload);
    
    for (const key of keys) {
      const colName = COLLECTION_MAP[key];
      if (!colName) continue;

      const rawData = payload[key];
      if (rawData === undefined) continue;

      if (colName === "customManual") {
        const docRef = doc(db, "customManual", "main");
        const htmlContent = typeof rawData === "string" ? rawData : rawData?.html || rawData?.content || "";
        await setDoc(docRef, { html: htmlContent, updatedAt: new Date().toISOString() });
        continue;
      }

      if (Array.isArray(rawData)) {
        const cleanItems = JSON.parse(JSON.stringify(rawData));
        
        // 1. Fetch existing document IDs in this collection to clean up deleted items
        const collRef = collection(db, colName);
        let existingDocIds: string[] = [];
        try {
          const existingSnap = await getDocs(collRef);
          existingDocIds = existingSnap.docs.map(d => d.id);
        } catch (e) {
          // Ignore read errors for empty collections
        }

        const currentItemIds = new Set<string>();
        cleanItems.forEach((item: any) => {
          const docId = getItemDocId(item);
          item.id = docId; // ensure id is stored in document
          currentItemIds.add(docId);
        });

        const idsToDelete = existingDocIds.filter(id => !currentItemIds.has(id));

        // 2. Perform batched writes/deletes (Firestore limits writeBatch to 500 items)
        const batchSize = 400;
        const allOps: Array<{ type: 'set' | 'delete'; id: string; data?: any }> = [
          ...cleanItems.map((item: any) => ({ type: 'set' as const, id: getItemDocId(item), data: item })),
          ...idsToDelete.map((id: string) => ({ type: 'delete' as const, id }))
        ];

        for (let i = 0; i < allOps.length; i += batchSize) {
          const chunk = allOps.slice(i, i + batchSize);
          const batch = writeBatch(db);
          chunk.forEach(op => {
            const docRef = doc(db, colName, op.id);
            if (op.type === 'set') {
              batch.set(docRef, op.data, { merge: true });
            } else {
              batch.delete(docRef);
            }
          });
          await batch.commit();
        }
      }
    }

    console.log("[ClientFirebase] Alterações documento por documento persistidas no Firestore com sucesso!");
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

