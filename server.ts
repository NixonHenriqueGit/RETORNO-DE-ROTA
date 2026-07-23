import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { promises as fs } from "fs";

import { initializeApp, getApps, getApp, deleteApp } from "firebase/app";
import { initializeFirestore, doc, getDoc, setDoc, getDocFromServer, setLogLevel, collection, getDocs, deleteDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

dotenv.config();

// Silence verbose or harmless Firestore warnings/info logs (e.g. Disconnecting idle stream)
setLogLevel("silent");

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: []
    },
    operationType,
    path
  };
  console.warn('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const DB_FILE_PATH = path.join(process.cwd(), "database.json");
const FIREBASE_CONFIG_PATH = path.join(process.cwd(), "firebase-applet-config.json");

const DB_KEYS = [
  "users", "drivers", "vehicles", "products", "activeAssets", 
  "audits", "vales", "returnForecasts", "fiscalAlerts", 
  "importedRoutes", "audit_logs"
];

// Helper to chunk large arrays to prevent exceeding Firestore 1MB document limit
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// In-memory database cache to prevent file reading during high-frequency polling and avoid race conditions
let dbCache: any = null;
let firestoreDb: any = null;
let storageInstance: any = null;
let firestoreLoadedSuccessfully = false;
let firestoreAttemptedConnection = false;
let firestoreQuotaExceeded = false;
let storageQuotaExceeded = false;

let startupSyncPromise: Promise<void> | null = null;
let startupSyncCompleted = false;

async function ensureDatabaseSynced() {
  if (startupSyncPromise) {
    await startupSyncPromise;
  }
}

// Check if error is related to Firebase Quota limits being exceeded or document size exceeded
function checkQuotaExceeded(error: any) {
  if (!error) return;
  const msg = String(error?.message || error).toUpperCase();
  
  if (msg.includes("EXCEEDS THE MAXIMUM ALLOWED SIZE") || msg.includes("MAXIMUM DOCUMENT SIZE")) {
    console.warn("==========================================================================");
    console.warn(">>> ERROR: FIRESTORE DOCUMENT SIZE LIMIT EXCEEDED (1 MiB) <<<");
    console.warn("Um documento excedeu o limite físico de 1 MiB do Firestore.");
    console.warn("Isso é um problema de modelagem de dados (documento com array gigante).");
    console.warn("Recomenda-se realizar a migração de schema para um documento por registro!");
    console.warn("==========================================================================");
    return; // Do NOT set firestoreQuotaExceeded flag
  }

  // Handle Firebase Storage-specific errors (quota, permissions, unknown, unauthorized, project-not-found)
  if (msg.includes("STORAGE/") || msg.includes("STORAGE-LIMIT") || msg.includes("STORAGE_LIMIT")) {
    if (!storageQuotaExceeded) {
      storageQuotaExceeded = true;
      console.warn("==========================================================================");
      console.warn(">>> WARN: FIREBASE STORAGE UNAVAILABLE OR LIMIT EXCEEDED <<<");
      console.warn("Sincronização com o Firebase Storage desativada nesta sessão.");
      console.warn("O sistema usará cache local de fotos de forma resiliente e transparente.");
      console.warn("==========================================================================");
    }
  }

  if (
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("QUOTA LIMIT EXCEEDED") ||
    msg.includes("QUOTA EXCEEDED") ||
    msg.includes("QUOTA_EXCEEDED") ||
    msg.includes("FREE DAILY WRITE UNITS") ||
    msg.includes("LIMIT EXCEEDED")
  ) {
    if (!firestoreQuotaExceeded) {
      firestoreQuotaExceeded = true;
      firestoreDb = null; // Dynamically disable Firestore to prevent further errors
      console.warn("==========================================================================");
      console.warn(">>> WARN: FIREBASE FIRESTORE QUOTA EXCEEDED (RESOURCE_EXHAUSTED) <<<");
      console.warn("Sincronização com o Firestore desabilitada dinamicamente para esta sessão.");
      console.warn("O aplicativo continuará funcionando perfeitamente usando database.json local!");
      console.warn("==========================================================================");
    }
  }
}

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCU7wOQObjxciIXk8pJG7MHpKV5s5x1Upw",
  authDomain: "armazem-facil--oficial.firebaseapp.com",
  projectId: "armazem-facil--oficial",
  storageBucket: "armazem-facil--oficial.firebasestorage.app",
  messagingSenderId: "199175774274",
  appId: "1:199175774274:web:0c4c91259e08877288cddb",
  measurementId: "G-Q25WX12SWG",
  firestoreDatabaseId: ""
};

// Keep track of connected clients for Server-Sent Events (SSE) real-time synchronization
let clients: any[] = [];

// Helper to initialize Firebase App and Firestore
async function initFirebase(forceReinit = false) {
  if (firestoreDb && !forceReinit) return;
  try {
    let config = { ...DEFAULT_FIREBASE_CONFIG };
    const configExists = await fs.access(FIREBASE_CONFIG_PATH).then(() => true).catch(() => false);
    if (configExists) {
      try {
        const configContent = await fs.readFile(FIREBASE_CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(configContent);
        // Check if configuration has placeholder values or is empty
        if (
          parsed &&
          parsed.projectId && parsed.projectId !== "remixed-project-id" &&
          parsed.apiKey && parsed.apiKey !== "remixed-api-key" &&
          !parsed.projectId.includes("placeholder")
        ) {
          config = parsed;
        } else {
          console.log("Valores do config file são placeholders. Usando banco de dados padrão integrado no código.");
        }
      } catch (e) {
        console.warn("Erro ao ler config file, usando banco de dados padrão integrado no código:", e);
      }
    } else {
      console.log("Config file não encontrado. Usando banco de dados padrão integrado no código.");
    }
    
    firestoreAttemptedConnection = true;
    
    let app;
    const apps = getApps();
    if (forceReinit || apps.length > 0) {
      for (const existingApp of apps) {
        try {
          await deleteApp(existingApp);
        } catch (e) {
          console.warn("Erro ao deletar app Firebase existente:", e);
        }
      }
    }
    
    app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId
    });

    // Use specified custom Firestore database ID if available
    const dbId = (config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)") ? config.firestoreDatabaseId : undefined;
    const dbInstance = initializeFirestore(app, {
      experimentalForceLongPolling: true,
    }, dbId);
    console.log("Firebase Firestore inicializado com sucesso.");

    try {
      storageInstance = getStorage(app);
      console.log("Firebase Storage inicializado com sucesso.");
    } catch (storageInitErr: any) {
      console.log("Erro ao inicializar Firebase Storage:", storageInitErr?.message || storageInitErr);
    }

    // Validate connection
    try {
      await Promise.race([
        getDocFromServer(doc(dbInstance, "test", "connection")),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout validando conexão com Firestore")), 4000))
      ]);
      console.log("Conexão com Firestore validada com sucesso.");
      firestoreDb = dbInstance; // Only set if validated
      firestoreLoadedSuccessfully = true;
      firestoreQuotaExceeded = false;
    } catch (error: any) {
      checkQuotaExceeded(error);
      const errMsg = error instanceof Error ? error.message : String(error);
      if (
        firestoreQuotaExceeded ||
        errMsg.includes("the client is offline") || 
        errMsg.includes("PERMISSION_DENIED") || 
        errMsg.includes("permission-denied") || 
        errMsg.includes("Timeout")
      ) {
        console.warn("Falha de conexão, cota ou permissão com Firestore:", errMsg);
        console.warn("Desabilitando Firestore para evitar atrasos ou travamentos nos salvamentos.");
        firestoreDb = null;
        firestoreLoadedSuccessfully = false;
      } else {
        console.log("Conexão validada (retornou erro esperado ou resposta offline):", errMsg);
        firestoreDb = dbInstance;
        firestoreLoadedSuccessfully = true;
        firestoreQuotaExceeded = false;
      }
    }
  } catch (err) {
    console.warn("Erro ao inicializar Firebase. Usando fallback de arquivo local:", err);
    firestoreDb = null;
    firestoreLoadedSuccessfully = false;
  }
}

// Generate audit logs comparing old and new states
function generateAuditLogs(oldDb: any, newDb: any, user: any) {
  const logs: any[] = [];
  const timestamp = new Date().toISOString();
  const userName = user ? `${user.name} (${user.role === 'auxiliar_logistica' ? 'Auxiliar' : user.role === 'gestor' ? 'Gestor' : user.role === 'conferente' ? 'Conferente' : user.role})` : "Sistema/Carga Planilha";

  for (const key of DB_KEYS) {
    if (key === "audit_logs" || key === "photos") continue; // Don't diff logs or raw base64 photos
    if (newDb[key] !== undefined) {
      const oldList = oldDb ? (oldDb[key] || []) : [];
      const newList = newDb[key] || [];

      if (oldList.length < newList.length) {
        // Items created
        const added = newList.filter((item: any) => !oldList.some((old: any) => 
          (item.id && old.id && item.id === old.id) || 
          (item.code && old.code && item.code === old.code) || 
          (item.plate && old.plate && item.plate === old.plate)
        ));
        const details = added.map((item: any) => {
          if (item.routeMap) return `Mapa Rota '${item.routeMap}'`;
          if (item.name) return `'${item.name}'`;
          if (item.plate) return `Placa '${item.plate}'`;
          if (item.description) return `Produto '${item.description}'`;
          return `ID: ${item.id || item.code}`;
        }).join(", ");
        
        logs.push({
          id: `log_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
          timestamp,
          user: userName,
          operation: "CRIAÇÃO",
          details: `Adicionou registro(s) em '${key}': ${details || 'novos registros'}.`
        });
      } else if (oldList.length > newList.length) {
        // Items deleted
        const removed = oldList.filter((old: any) => !newList.some((item: any) => 
          (item.id && old.id && item.id === old.id) || 
          (item.code && old.code && item.code === old.code) || 
          (item.plate && old.plate && item.plate === old.plate)
        ));
        const details = removed.map((item: any) => {
          if (item.routeMap) return `Mapa Rota '${item.routeMap}'`;
          if (item.name) return `'${item.name}'`;
          if (item.plate) return `Placa '${item.plate}'`;
          if (item.description) return `Produto '${item.description}'`;
          return `ID: ${item.id || item.code}`;
        }).join(", ");

        logs.push({
          id: `log_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
          timestamp,
          user: userName,
          operation: "EXCLUSÃO",
          details: `Removeu registro(s) de '${key}': ${details || 'registros deletados'}.`
        });
      } else {
        // Check for modifications
        const changed = newList.filter((item: any) => {
          const oldItem = oldList.find((old: any) => 
            (item.id && old.id && item.id === old.id) || 
            (item.code && old.code && item.code === old.code) || 
            (item.plate && old.plate && item.plate === old.plate)
          );
          return oldItem && JSON.stringify(oldItem) !== JSON.stringify(item);
        });

        if (changed.length > 0) {
          let editDetails = "";
          if (key === "audits") {
            editDetails = changed.map((a: any) => {
              const oldA = oldList.find((old: any) => old.id === a.id);
              return `Mapa '${a.routeMap}' de status '${oldA?.status}' para '${a.status}'`;
            }).join(", ");
          } else if (key === "vales") {
            editDetails = changed.map((v: any) => {
              const oldV = oldList.find((old: any) => old.id === v.id);
              return `Vale de ${v.colaboradorName} de status '${oldV?.status}' para '${v.status}'`;
            }).join(", ");
          } else if (key === "returnForecasts") {
            editDetails = changed.map((f: any) => {
              const oldF = oldList.find((old: any) => old.id === f.id);
              return `Previsão do mapa '${f.routeMap}' de status '${oldF?.status}' para '${f.status}'`;
            }).join(", ");
          } else {
            editDetails = changed.map((item: any) => item.routeMap || item.name || item.plate || item.description || item.id || item.code).join(", ");
          }

          logs.push({
            id: `log_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            timestamp,
            user: userName,
            operation: "EDIÇÃO",
            details: `Atualizou registros em '${key}'${editDetails ? `: ${editDetails}` : ''}.`
          });
        }
      }
    }
  }
  return logs;
}

// Helper to read DB from file/Firestore once on startup and establish a robust cache
async function loadDatabaseOnStartup() {
  if (firestoreAttemptedConnection) return;
  firestoreAttemptedConnection = true;
  
  // 1. Warm up the cache instantly with local database.json fallback
  // This ensures the server is responsive and has valid data immediately.
  await loadFromLocalFallback();
  await runDatabaseMigration();

  const configExists = await fs.access(FIREBASE_CONFIG_PATH).then(() => true).catch(() => false);
  if (configExists) {
    try {
      const configContent = await fs.readFile(FIREBASE_CONFIG_PATH, "utf-8");
      const config = JSON.parse(configContent);
      if (
        config.projectId && config.projectId !== "remixed-project-id" &&
        config.apiKey && config.apiKey !== "remixed-api-key" &&
        !config.projectId.includes("placeholder")
      ) {
        // Capture promise to await on DB operations so we NEVER serve stale or blank state
        startupSyncPromise = (async () => {
          try {
            await runFirebaseSyncInBackground();
            await runDatabaseMigration();
          } catch (err) {
            console.warn("Erro durante o sync inicial do Firebase:", err);
          } finally {
            startupSyncCompleted = true;
          }
        })();
        return;
      }
    } catch (e) {
      console.warn("Erro ao verificar configuração do Firebase para sincronização inicial:", e);
    }
  }

  // If no Firebase config or error, complete instantly
  startupSyncCompleted = true;
}

// Perform Firebase connection and sync in the background asynchronously
async function runFirebaseSyncInBackground() {
  await initFirebase();
  
  if (firestoreDb) {
    try {
      console.log("Carregando banco de dados a partir do Firebase Firestore...");
      
      const localDb = dbCache || {};

      // Realiza um fetch de cada documento/controle no Firestore
      const updatedKeys = new Set<string>();
      const absentKeys = new Set<string>();
      const readPromises = DB_KEYS.map(async (key) => {
        const docRef = doc(firestoreDb, "app_state", key);
        try {
          // Adiciona um timeout de 10 segundos para cada documento para evitar travamentos indefinidos
          const snap = await Promise.race([
            getDoc(docRef),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout lendo ${key} do Firestore`)), 10000))
          ]);
          if (snap.exists()) {
            const docData = snap.data();
            let loadedData: any[] = [];

            if (docData && docData.chunkCount !== undefined) {
              const chunkCount = docData.chunkCount;
              console.log(`Carregando ${chunkCount} chunks para a chave '${key}'...`);
              const chunks: any[] = [];
              const chunkPromises = [];
              for (let i = 0; i < chunkCount; i++) {
                const chunkDocRef = doc(firestoreDb, "app_state", `${key}_chunk_${i}`);
                const chunkPromise = Promise.race([
                  getDoc(chunkDocRef),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout lendo ${key}_chunk_${i} do Firestore`)), 8000))
                ]).then((chunkSnap) => {
                  if (chunkSnap.exists()) {
                    chunks[i] = chunkSnap.data().data || [];
                  } else {
                    chunks[i] = [];
                  }
                }).catch((chunkErr) => {
                  console.warn(`Erro ao carregar chunk ${i} para a chave ${key}:`, chunkErr);
                  chunks[i] = [];
                });
                chunkPromises.push(chunkPromise);
              }
              await Promise.all(chunkPromises);
              loadedData = chunks.flat();
            } else {
              loadedData = (docData && docData.data) || [];
            }

            if (key === "audit_logs") {
              const cutoffTime = Date.now() - 48 * 60 * 60 * 1000;
              loadedData = loadedData.filter((log: any) => {
                if (!log.timestamp) return false;
                return new Date(log.timestamp).getTime() >= cutoffTime;
              });
            }

            if (key === "users") {
              const localUsers = localDb.users || [];
              const mergedUsersMap = new Map();
              localUsers.forEach((u: any) => {
                if (u && (u.username || u.id)) {
                  mergedUsersMap.set((u.username || u.id).toString().toLowerCase(), u);
                }
              });
              loadedData.forEach((u: any) => {
                if (u && (u.username || u.id)) {
                  const uKey = (u.username || u.id).toString().toLowerCase();
                  const existing = mergedUsersMap.get(uKey);
                  if (existing) {
                    mergedUsersMap.set(uKey, { ...existing, ...u });
                  } else {
                    mergedUsersMap.set(uKey, u);
                  }
                }
              });
              loadedData = Array.from(mergedUsersMap.values());
            }
            dbCache[key] = loadedData;
            updatedKeys.add(key);
          } else {
            absentKeys.add(key);
          }
        } catch (readErr: any) {
          console.warn(`Erro ao ler documento '${key}' no Firestore:`, readErr?.message || readErr);
          checkQuotaExceeded(readErr);
          // Non-blocking fallback: keep the localDb data already populated in dbCache[key]
          console.log(`Usando dados locais de fallback para '${key}' devido à falha de leitura.`);
        }
      });
      await Promise.all(readPromises);

      // Carrega fotos de documentos individuais no Firestore para contornar limite de 1MB por documento do Firestore
      try {
        console.log("Carregando fotos individuais da coleção 'photos' no Firestore...");
        const photosCol = collection(firestoreDb, "photos");
        const photosSnap = await Promise.race([
          getDocs(photosCol),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout lendo coleção 'photos'")), 15000))
        ]);
        const photosList: any[] = [];
        photosSnap.forEach((docSnap) => {
          photosList.push(docSnap.data());
        });
        
        // Merge client-side or disk photos with firestore photos so we NEVER wipe out photos on empty Firestore collections
        const localPhotos = localDb.photos || [];
        const mergedPhotosMap = new Map();
        localPhotos.forEach((p: any) => { if (p && p.id) mergedPhotosMap.set(p.id, p); });
        photosList.forEach((p: any) => { if (p && p.id) mergedPhotosMap.set(p.id, p); });
        dbCache.photos = Array.from(mergedPhotosMap.values());

        console.log(`Carregadas ${photosList.length} fotos do Firestore com sucesso. Cache total de fotos: ${dbCache.photos.length}`);
      } catch (photoReadErr: any) {
        console.warn("Erro ao carregar fotos individuais do Firestore:", photoReadErr?.message || photoReadErr);
        checkQuotaExceeded(photoReadErr);
        // Non-blocking fallback: keep local photos if Firestore fails
        dbCache.photos = localDb.photos || [];
      }

      console.log(`Dados carregados do Firestore com sucesso. Documentos encontrados: ${Array.from(updatedKeys).join(", ")}`);

      // Se houver chaves que existem no localDb mas NÃO no Firestore (ex: primeira inicialização),
      // salvamos o valor padrão no Firestore de forma chunked para evitar erros de tamanho.
      for (const key of DB_KEYS) {
        if (absentKeys.has(key) && !firestoreQuotaExceeded) {
          console.log(`Inicializando documento '${key}' ausente no Firestore com os dados padrão do database.json...`);
          try {
            const array = dbCache[key] || [];
            const chunks = chunkArray(array, 500);

            // Salva cada chunk
            for (let i = 0; i < chunks.length; i++) {
              const chunkDocRef = doc(firestoreDb, "app_state", `${key}_chunk_${i}`);
              await setDoc(chunkDocRef, { data: chunks[i] });
            }

            // Salva o documento de controle
            const docRef = doc(firestoreDb, "app_state", key);
            await setDoc(docRef, { chunkCount: chunks.length });
          } catch (setErr) {
            console.warn(`Erro ao gravar carga padrão inicial do '${key}' no Firestore:`, setErr);
            checkQuotaExceeded(setErr);
          }
        }
      }

      // Salva o estado consolidado no arquivo local database.json para aquecer o cache físico do container
      const tempPath = `${DB_FILE_PATH}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(dbCache, null, 2), "utf-8");
      await fs.rename(tempPath, DB_FILE_PATH);
      console.log("Cache físico do container atualizado com os dados do Firestore com sucesso.");
      
      firestoreLoadedSuccessfully = true;

      // Se houver clientes conectados, propaga a atualização em tempo real
      if (clients && clients.length > 0) {
        const payloadStr = JSON.stringify({ type: "update", db: dbCache });
        clients.forEach(client => {
          try {
            client.res.write(`data: ${payloadStr}\n\n`);
          } catch (err) {
            // ignore
          }
        });
      }
    } catch (err) {
      console.warn("Falha ao carregar o banco de dados a partir do Firestore. Continuando com o cache local:", err);
    }
  }
}

async function loadFromLocalFallback() {
  try {
    const localDb = await readLocalDatabaseFile();
    if (localDb) {
      dbCache = localDb;
      if (dbCache.audit_logs) {
        const cutoffTime = Date.now() - 48 * 60 * 60 * 1000;
        dbCache.audit_logs = dbCache.audit_logs.filter((log: any) => {
          if (!log.timestamp) return false;
          return new Date(log.timestamp).getTime() >= cutoffTime;
        });
      }
      console.log("Banco de dados local em cache com sucesso.");
    } else {
      dbCache = {};
      for (const key of DB_KEYS) {
        dbCache[key] = [];
      }
      dbCache.photos = [];
    }
  } catch (error) {
    console.error("Erro ao carregar banco de dados local na inicialização:", error);
  }
}

// Helper to read from local database.json file
async function readLocalDatabaseFile() {
  try {
    await fs.access(DB_FILE_PATH);
    const content = await fs.readFile(DB_FILE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Helper to read DB safely (returns cache if available, otherwise reads local or Firestore)
async function readDatabaseFile() {
  if (dbCache) return dbCache;
  return await readLocalDatabaseFile();
}

let writeQueuePromise: Promise<any> = Promise.resolve();

// Helper to write DB atomically to local file and SYNCHRONOUSLY sync to Firestore
async function writeDatabaseFile(data: any, dirtyKeys?: string[]) {

  // Chain the write operation to the end of the queue to completely prevent race conditions
  const resultPromise = writeQueuePromise.then(async () => {
    try {
      // 1. Save to local disk (atomic write with guaranteed unique temp path to prevent collisions)
      const tempPath = `${DB_FILE_PATH}.tmp_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tempPath, DB_FILE_PATH);

      // 2. Sync to Firestore with strict timeout to guarantee absolute persistence without blocking the server or client
      if (firestoreDb && !firestoreQuotaExceeded) {
        const keys = dirtyKeys !== undefined ? dirtyKeys : DB_KEYS;
        const syncPromises = keys.map(async (key) => {
          if (data[key] !== undefined) {
            const docRef = doc(firestoreDb, "app_state", key);
            try {
              const array = data[key] || [];
              const chunks = chunkArray(array, 500);

              // Get old chunk count first to clean up obsolete chunks and avoid orphaned documents
              let oldChunkCount = 0;
              try {
                const controlSnap = await Promise.race([
                  getDoc(docRef),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout lendo controle")), 1500))
                ]);
                if (controlSnap.exists()) {
                  oldChunkCount = controlSnap.data().chunkCount || 0;
                }
              } catch (e) {
                // Ignore, treat as 0
              }

              // Write each chunk with a strict 2.5-second timeout per document write in parallel
              const chunkPromises = chunks.map(async (chunk, i) => {
                const chunkDocRef = doc(firestoreDb, "app_state", `${key}_chunk_${i}`);
                await Promise.race([
                  setDoc(chunkDocRef, { data: chunk }),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout sincronizando '${key}_chunk_${i}' com Firestore`)), 2500))
                ]);
              });
              await Promise.all(chunkPromises);

              // Write the control document
              await Promise.race([
                setDoc(docRef, { chunkCount: chunks.length }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout sincronizando controle '${key}'`)), 2000))
              ]);

              // Delete obsolete chunks if the new array is smaller
              if (oldChunkCount > chunks.length) {
                const deletePromises = [];
                for (let i = chunks.length; i < oldChunkCount; i++) {
                  const obsoleteDocRef = doc(firestoreDb, "app_state", `${key}_chunk_${i}`);
                  deletePromises.push(
                    Promise.race([
                      deleteDoc(obsoleteDocRef),
                      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout deletando '${key}_chunk_${i}'`)), 2000))
                    ]).catch((delErr) => {
                      console.warn(`Erro não crítico ao deletar chunk obsoleto ${key}_chunk_${i}:`, delErr);
                    })
                  );
                }
                await Promise.all(deletePromises);
              }
            } catch (setErr: any) {
              console.warn(`Erro ao sincronizar chave '${key}' no Firestore (não bloqueante):`, setErr?.message || setErr);
              checkQuotaExceeded(setErr);
            }
          }
        });
        await Promise.all(syncPromises);
      }

      // 3. Broadcast real-time update to all connected SSE clients to keep multi-user dashboards in perfect sync
      if (clients && clients.length > 0) {
        // Exclude photos from the broadcast to prevent heavy payload transfer over SSE
        const broadcastData = { ...data };
        delete broadcastData.photos;
        const payloadStr = JSON.stringify({ type: "update", db: broadcastData });
        clients.forEach(client => {
          try {
            client.res.write(`data: ${payloadStr}\n\n`);
          } catch (err) {
            // Client might have closed their connection; ignore
          }
        });
      }

      return true;
    } catch (error) {
      console.error("Error writing database file:", error);
      return false;
    }
  });

  // Keep the queue moving even if the promise fails
  writeQueuePromise = resultPromise.then(() => {}).catch(() => {});
  return resultPromise;
}

// Migration service to extract any embedded base64 photoUrl from audits and move to separate photos collection
async function runDatabaseMigration() {
  if (!dbCache || !dbCache.audits || dbCache.audits.length === 0) {
    return;
  }

  let migratedCount = 0;
  let hasChanges = false;

  const audits = dbCache.audits;
  if (!dbCache.photos) {
    dbCache.photos = [];
  }
  const photos = dbCache.photos;

  // Let's scan if there are any refugos with base64 photos
  const needsMigration = audits.some((audit: any) => 
    audit.refugos && audit.refugos.some((ref: any) => ref.photoUrl && ref.photoUrl.startsWith("data:image"))
  );

  if (!needsMigration) {
    console.log("[Migration] Nenhuma foto base64 encontrada embutida nos refugos. Migração desnecessária.");
    return;
  }

  console.log("[Migration] Iniciando migração de fotos embutidas em base64 para a coleção de fotos...");

  // 1. Perform backup of audits array
  try {
    const backupDir = path.join(process.cwd(), "shared_folder");
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `audits_backup_migration.json`);
    await fs.writeFile(backupPath, JSON.stringify(audits, null, 2), "utf-8");
    console.log(`[Migration] Backup de segurança salvo com sucesso em: ${backupPath}`);
  } catch (backupErr) {
    console.error("[Migration] Falha ao criar backup de segurança, abortando migração por segurança:", backupErr);
    return;
  }

  // 2. Perform extraction and migration
  for (const audit of audits) {
    if (!audit.refugos || audit.refugos.length === 0) continue;

    for (const ref of audit.refugos) {
      if (ref.photoUrl && ref.photoUrl.startsWith("data:image")) {
        const base64Photo = ref.photoUrl;
        const photoId = `photo_migrated_${audit.id}_${ref.assetId}_${Math.random().toString(36).substring(2, 7)}`;
        
        const matchedDriver = dbCache.drivers?.find((d: any) => d.id === audit.driverId);
        const driverName = matchedDriver ? matchedDriver.name : (audit.driverId || '');
        
        const photoRecord = {
          id: photoId,
          auditId: audit.id,
          itemCode: ref.assetId,
          itemName: `Refugo Migrado: ${ref.assetName} (${ref.reason})`,
          photoUrl: base64Photo,
          timestamp: audit.endTime || audit.startTime || new Date().toISOString(),
          conferenteId: audit.conferenteId || 'system',
          driverId: audit.driverId || '',
          driverName: driverName,
          type: 'refugo',
          syncPending: true // Mark as syncPending so background sync will save to cloud storage/Firestore
        };

        // Add to cache
        photos.push(photoRecord);

        // Update refugo record
        ref.photoId = photoId;
        delete ref.photoUrl; // Remove base64 from audit session record

        migratedCount++;
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    console.log(`[Migration] Migradas com sucesso ${migratedCount} fotos embutidas para o cache central de fotos.`);
    
    // Save to local database file
    try {
      const tempPath = `${DB_FILE_PATH}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(dbCache, null, 2), "utf-8");
      await fs.rename(tempPath, DB_FILE_PATH);
      console.log("[Migration] Cache físico atualizado localmente com os dados migrados.");
    } catch (saveErr) {
      console.error("[Migration] Erro ao salvar arquivo local pós-migração:", saveErr);
    }

    // Save to Firestore if connected
    if (firestoreDb && !firestoreQuotaExceeded) {
      try {
        console.log("[Migration] Sincronizando dados migrados com o Firestore...");
        
        // Save updated audits (which now have references instead of base64)
        const auditsChunks = chunkArray(dbCache.audits, 500);
        for (let i = 0; i < auditsChunks.length; i++) {
          const chunkDocRef = doc(firestoreDb, "app_state", `audits_chunk_${i}`);
          await setDoc(chunkDocRef, { data: auditsChunks[i] });
        }
        const auditsControlRef = doc(firestoreDb, "app_state", "audits");
        await setDoc(auditsControlRef, { chunkCount: auditsChunks.length });

        // Save newly created photos
        const newlyAddedPhotos = photos.filter((p: any) => p.id.startsWith("photo_migrated_"));
        console.log(`[Migration] Gravando ${newlyAddedPhotos.length} fotos migradas no Firestore...`);
        for (const p of newlyAddedPhotos) {
          const docRef = doc(firestoreDb, "photos", p.id);
          await setDoc(docRef, p);
        }
        
        console.log("[Migration] Sincronização de migração concluída com sucesso no Firestore.");
      } catch (fsErr) {
        console.error("[Migration] Erro ao sincronizar migração com o Firestore:", fsErr);
      }
    }
  }
}

// Automated 90-day cleanup service for photos, audits (operations) and logs
async function autoPruneData() {
  if (!dbCache) return;
  try {
    const hoursCutoff = 2160; // 90 days retention for complete permanent record integrity
    const cutoffTime = Date.now() - (hoursCutoff * 60 * 60 * 1000);
    const cutoffDate = new Date(cutoffTime);

    console.log(`[AutoPrune] Iniciando limpeza automática de registros com mais de ${hoursCutoff} horas / 90 dias (anteriores a ${cutoffDate.toISOString()})...`);

    let changed = false;
    const dirtyKeys: string[] = [];

    // 1. Prune finished audits (operações finalizadas)
    if (dbCache.audits && Array.isArray(dbCache.audits)) {
      const initialCount = dbCache.audits.length;
      const filteredAudits = dbCache.audits.filter((audit: any) => {
        const isFinalized = audit.status === 'finalizado_ok' || audit.status === 'finalizado_divergente';
        if (!isFinalized) return true; // Keep active/in-progress audits

        const auditTimeStr = audit.endTime || audit.startTime || audit.arrivalDate;
        if (!auditTimeStr) return true; // Safety keep if no timestamp
        const auditTime = new Date(auditTimeStr).getTime();
        return auditTime >= cutoffTime; // Keep if within 48 hours
      });

      if (filteredAudits.length < initialCount) {
        console.log(`[AutoPrune] Removidos ${initialCount - filteredAudits.length} auditorias finalizadas antigas.`);
        dbCache.audits = filteredAudits;
        changed = true;
        dirtyKeys.push("audits");
      }
    }

    // 2. Prune audit logs
    if (dbCache.audit_logs && Array.isArray(dbCache.audit_logs)) {
      const initialCount = dbCache.audit_logs.length;
      const filteredLogs = dbCache.audit_logs.filter((log: any) => {
        if (!log.timestamp) return true;
        const logTime = new Date(log.timestamp).getTime();
        return logTime >= cutoffTime;
      });

      if (filteredLogs.length < initialCount) {
        console.log(`[AutoPrune] Removidos ${initialCount - filteredLogs.length} logs de auditoria antigos.`);
        dbCache.audit_logs = filteredLogs;
        changed = true;
        dirtyKeys.push("audit_logs");
      }
    }

    // 3. Prune photos
    if (dbCache.photos && Array.isArray(dbCache.photos)) {
      const initialCount = dbCache.photos.length;
      const toKeep = dbCache.photos.filter((p: any) => {
        if (!p.timestamp) return true;
        const photoTime = new Date(p.timestamp).getTime();
        return photoTime >= cutoffTime;
      });
      const toPrune = dbCache.photos.filter((p: any) => {
        if (!p.timestamp) return false;
        const photoTime = new Date(p.timestamp).getTime();
        return photoTime < cutoffTime;
      });

      if (toPrune.length > 0) {
        console.log(`[AutoPrune] Removidos ${toPrune.length} registros fotográficos com mais de 48 horas.`);
        dbCache.photos = toKeep;
        changed = true;

        // Sync deletion to Firestore
        if (firestoreDb && !firestoreQuotaExceeded) {
          try {
            const { deleteDoc } = await import("firebase/firestore");
            let deletedCount = 0;
            for (const p of toPrune) {
              if (firestoreQuotaExceeded) {
                console.log("[AutoPrune] Cota do Firestore excedida durante o processamento. Abortando loop de exclusão.");
                break;
              }
              const docRef = doc(firestoreDb, "photos", p.id);
              await deleteDoc(docRef);
              deletedCount++;
            }
            if (deletedCount > 0) {
              console.log(`[AutoPrune] Sincronizada exclusão de ${deletedCount} fotos antigas no Firestore.`);
            }
          } catch (fsErr: any) {
            console.warn("[AutoPrune] Erro ao sincronizar exclusão de fotos no Firestore:", fsErr);
            checkQuotaExceeded(fsErr);
          }
        }
      }
    }

    if (changed) {
      console.log(`[AutoPrune] Salvando alterações limpas no banco de dados.`);
      await writeDatabaseFile(dbCache, dirtyKeys);
    }
  } catch (err) {
    console.error("[AutoPrune] Erro durante a limpeza de dados antigos:", err);
  }
}

// Helper to recursively find a file in a directory
async function findFileRecursively(dir: string, filename: string): Promise<string | null> {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        const found = await findFileRecursively(fullPath, filename);
        if (found) return found;
      } else if (file.isFile() && file.name === filename) {
        return fullPath;
      }
    }
  } catch (err) {
    // Ignore folder not found or reading error
  }
  return null;
}

// Background photo pruning job validating existing PDF > 24 hours after Baixa
async function runBackgroundPhotoPruning() {
  try {
    console.log("[Photo Pruner] Iniciando verificação assíncrona para limpeza de fotos com PDF validado...");
    if (!dbCache) {
      const db = await readDatabaseFile();
      dbCache = db || {};
    }
    const audits = dbCache.audits || [];
    let photos = dbCache.photos || [];
    if (audits.length === 0 || photos.length === 0) {
      console.log("[Photo Pruner] Sem auditorias ou fotos para verificar.");
      return;
    }

    const now = Date.now();
    const safeRetentionMs = 15 * 24 * 60 * 60 * 1000; // Keep photos for at least 15 days even after PDF validation for auxiliary review
    let databaseChanged = false;
    
    // Select audits that are finalized (baixados) and have been closed for at least 15 days
    const closedAudits = audits.filter((a: any) => 
      (a.status === 'finalizado_ok' || a.status === 'finalizado_divergente') &&
      a.endTime &&
      (now - new Date(a.endTime).getTime() >= safeRetentionMs)
    );

    const baseDir = path.join(process.cwd(), "shared_folder", "Mapas_Baixados");

    for (const audit of closedAudits) {
      const arrivalDateStr = audit.arrivalDate || new Date().toISOString().split('T')[0];
      const [yearPart, monthPart, dayPart] = arrivalDateStr.split('-');
      const formattedDate = `${dayPart}-${monthPart}-${yearPart}`;
      const filename = `${audit.routeMap} - ${audit.plate} - ${formattedDate}.pdf`;

      // Find if PDF file exists and has size > 0
      const pdfPath = await findFileRecursively(baseDir, filename);
      if (pdfPath) {
        const stats = await fs.stat(pdfPath);
        if (stats.size > 0) {
          // Validated! Safe to prune photos of this audit from the platform
          const photosToPrune = photos.filter((p: any) => p.auditId === audit.id);
          if (photosToPrune.length > 0) {
            console.log(`[Photo Pruner] Deletando com segurança ${photosToPrune.length} fotos do mapa ${audit.routeMap}. Motivo: PDF validado em rede externa e > 24h desde a baixa.`);
            
            // Filter out these photos from memory cache
            photos = photos.filter((p: any) => p.auditId !== audit.id);
            dbCache.photos = photos;
            databaseChanged = true;

            // Delete physical files from disk and Firebase Storage
            for (const p of photosToPrune) {
              await deletePhotoFromStorage(p.id).catch(() => {});
            }

            // Delete from Firestore if enabled
            if (firestoreDb && !firestoreQuotaExceeded) {
              const { deleteDoc } = await import("firebase/firestore");
              for (const p of photosToPrune) {
                if (firestoreQuotaExceeded) {
                  console.log("[Photo Pruner] Cota do Firestore excedida durante a execução do pruner. Abortando loop de deleção.");
                  break;
                }
                try {
                  const docRef = doc(firestoreDb, "photos", p.id);
                  await deleteDoc(docRef);
                } catch (delErr: any) {
                  console.warn(`[Photo Pruner] Erro ao deletar foto ${p.id} no Firestore:`, delErr);
                  checkQuotaExceeded(delErr);
                }
              }
            }
          }
        }
      }
    }

    if (databaseChanged) {
      await writeDatabaseFile(dbCache, []);
      console.log("[Photo Pruner] Limpeza assíncrona de fotos concluída e salva no banco de dados.");
    } else {
      console.log("[Photo Pruner] Nenhuma foto qualificada para limpeza segura neste ciclo.");
    }
  } catch (err) {
    console.error("[Photo Pruner] Erro crítico no pruner assíncrono:", err);
  }
}

/**
 * Helper to upload a base64 image to Firebase Storage (and local disk as robust fallback).
 * Returns the final storage URL (Firebase download URL or local /api/shared-files/... URL).
 */
async function uploadPhotoToStorageAndGetUrl(photoId: string, base64Data: string): Promise<string> {
  let cleanBase64 = base64Data;
  if (base64Data.startsWith("data:")) {
    const commaIndex = base64Data.indexOf(",");
    if (commaIndex !== -1) {
      cleanBase64 = base64Data.substring(commaIndex + 1);
    }
  }

  const buffer = Buffer.from(cleanBase64, "base64");
  const localDir = path.join(process.cwd(), "shared_folder", "photos");
  const localPath = path.join(localDir, `${photoId}.jpg`);

  try {
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(localPath, buffer);
  } catch (err) {
    console.error(`Erro ao salvar foto ${photoId} em disco local:`, err);
  }

  const localUrl = `/api/shared-files/photos/${photoId}.jpg`;

  if (storageInstance && !firestoreQuotaExceeded && !storageQuotaExceeded) {
    try {
      console.log(`[Storage] Enviando foto ${photoId} para nuvem...`);
      const storageRef = ref(storageInstance, `photos/${photoId}.jpg`);
      const uint8Array = new Uint8Array(buffer);
      
      await Promise.race([
        uploadBytes(storageRef, uint8Array, { contentType: "image/jpeg" }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout`)), 8000))
      ]);

      const downloadUrl = await getDownloadURL(storageRef);
      console.log(`[Storage] Foto ${photoId} enviada com sucesso para nuvem: ${downloadUrl}`);
      return downloadUrl;
    } catch (storageErr: any) {
      console.log(`[Storage] Usando cache de mídia local para foto ${photoId}`);
      checkQuotaExceeded(storageErr);
    }
  }

  // Fallback to local server URL for clean, fast, and light database entries
  return localUrl;
}

/**
 * Helper to delete a photo from disk and Firebase Storage
 */
async function deletePhotoFromStorage(photoId: string): Promise<void> {
  try {
    const localPath = path.join(process.cwd(), "shared_folder", "photos", `${photoId}.jpg`);
    await fs.unlink(localPath).catch(() => {});
  } catch (err) {
    // ignore
  }

  if (storageInstance && !firestoreQuotaExceeded && !storageQuotaExceeded) {
    try {
      const storageRef = ref(storageInstance, `photos/${photoId}.jpg`);
      await deleteObject(storageRef).catch(() => {});
    } catch (err) {
      // ignore
    }
  }
}

/**
 * Background recovery job to upload local-fallback photos to Firebase Storage once connected
 */
async function runBackgroundPhotoSync(): Promise<void> {
  if (!storageInstance || firestoreQuotaExceeded || storageQuotaExceeded) return;
  
  try {
    console.log("[Photo Syncer] Iniciando sincronização em segundo plano para fotos salvas localmente...");
    if (!dbCache) {
      const db = await readDatabaseFile();
      dbCache = db || {};
    }
    const photos = dbCache.photos || [];
    let updatedCount = 0;

    for (let i = 0; i < photos.length; i++) {
      if (firestoreQuotaExceeded || storageQuotaExceeded) {
        console.log("[Photo Syncer] Cota excedida durante o processamento. Abortando loop de sincronização.");
        break;
      }
      const p = photos[i];
      if (p.photoUrl && p.photoUrl.startsWith("/api/shared-files/photos/")) {
        const photoId = p.id;
        const localPath = path.join(process.cwd(), "shared_folder", "photos", `${photoId}.jpg`);
        
        try {
          await fs.access(localPath);
          const buffer = await fs.readFile(localPath);
          const uint8Array = new Uint8Array(buffer);
          
          console.log(`[Photo Syncer] Sincronizando foto pendente ${photoId} para o Firebase Storage...`);
          const storageRef = ref(storageInstance, `photos/${photoId}.jpg`);
          
          await uploadBytes(storageRef, uint8Array, { contentType: "image/jpeg" });
          const downloadUrl = await getDownloadURL(storageRef);
          
          p.photoUrl = downloadUrl;
          updatedCount++;

          if (firestoreDb && !firestoreQuotaExceeded) {
            const docRef = doc(firestoreDb, "photos", photoId);
            await setDoc(docRef, p);
          }
        } catch (err: any) {
          console.log(`[Photo Syncer] Falha ao sincronizar foto local ${photoId}:`, err?.message || err);
          checkQuotaExceeded(err);
          // Stop trying to upload subsequent photos in this sync task to prevent console flooding
          console.log("[Photo Syncer] Abortando restante da sincronização nesta execução devido ao erro no Storage.");
          break;
        }
      }
    }

    if (updatedCount > 0) {
      await writeDatabaseFile(dbCache, []);
      console.log(`[Photo Syncer] Sincronização em segundo plano concluída. ${updatedCount} fotos migradas para o Firebase Storage.`);
    } else {
      console.log("[Photo Syncer] Nenhuma foto local pendente de sincronização.");
    }
  } catch (syncErr) {
    console.log("[Photo Syncer] Erro ao sincronizar fotos em segundo plano:", syncErr);
  }
}

// Helper to recursively list PDFs inside the shared folder
async function getFilesRecursively(dir: string): Promise<any[]> {
  let results: any[] = [];
  let list;
  try {
    list = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  for (const file of list) {
    const resPath = path.resolve(dir, file.name);
    if (file.isDirectory()) {
      const subFiles = await getFilesRecursively(resPath);
      results = results.concat(subFiles);
    } else {
      if (file.name.toLowerCase().endsWith(".pdf")) {
        try {
          const stats = await fs.stat(resPath);
          const relativePath = path.relative(path.join(process.cwd(), "shared_folder"), resPath);
          results.push({
            name: file.name,
            size: stats.size,
            path: relativePath,
            url: `/api/shared-files/${relativePath.replace(/\\/g, "/")}`,
            mtime: stats.mtime
          });
        } catch (e) {
          // stats error, ignore
        }
      }
    }
  }
  return results;
}

async function startServer() {
  await loadDatabaseOnStartup();
  
  // Ensure shared_folder and shared_folder/photos directories exist
  try {
    await fs.mkdir(path.join(process.cwd(), "shared_folder"), { recursive: true });
    await fs.mkdir(path.join(process.cwd(), "shared_folder", "photos"), { recursive: true });
    console.log("Diretórios de rede (shared_folder e shared_folder/photos) verificados/criados com sucesso!");
  } catch (err) {
    console.error("Erro ao criar diretórios de rede:", err);
  }

  // Prime first prune and sync jobs immediately upon load
  autoPruneData().catch(e => console.error("Erro na poda inicial:", e));
  runBackgroundPhotoPruning().catch(e => console.error("Erro na poda inicial de fotos:", e));
  runBackgroundPhotoSync().catch(e => console.error("Erro na sincronização inicial de fotos locais:", e));

  // Set periodic 1h timer for pruning
  setInterval(() => {
    autoPruneData().catch(e => console.error("Erro na poda periódica:", e));
    runBackgroundPhotoPruning().catch(e => console.error("Erro na poda periódica de fotos:", e));
  }, 60 * 60 * 1000);

  // Set periodic 10m timer for background local photos synchronization
  setInterval(() => {
    runBackgroundPhotoSync().catch(e => console.error("Erro na sincronização periódica de fotos locais:", e));
  }, 10 * 60 * 1000);

  // Periodic keepalive for all connected Server-Sent Events clients (every 15 seconds)
  // This keeps the HTTP long-connection active and completely avoids proxy timeout errors (like net::ERR_INCOMPLETE_CHUNKED_ENCODING)
  setInterval(() => {
    if (clients && clients.length > 0) {
      clients.forEach(client => {
        try {
          client.res.write(": keepalive\n\n");
        } catch (e) {
          // ignore, client closed connection
        }
      });
    }
  }, 15000);

  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" })); // Raise limit for large datasets with signatures/images

  // Static serving of the shared folder
  app.use("/api/shared-files", express.static(path.join(process.cwd(), "shared_folder")));

  // API Route for Real-time database Server-Sent Events (SSE)
  app.get("/api/db/events", async (req, res) => {
    await ensureDatabaseSynced();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    // Send current DB state immediately upon connection (excluding photos for speed)
    if (dbCache) {
      const initialData = { ...dbCache };
      delete initialData.photos;
      res.write(`data: ${JSON.stringify({ type: "initial", db: initialData })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: "initial", db: {} })}\n\n`);
    }
    
    const client = { id: Date.now(), res };
    clients.push(client);
    
    req.on("close", () => {
      clients = clients.filter(c => c.id !== client.id);
    });
  });

  // API Route to fetch database state
  app.get("/api/db", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      // Return memory cache first to completely avoid reading disk during fast poll intervals
      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      
      const dataToSend = { ...dbCache };
      delete dataToSend.photos;
      res.json({ success: true, db: dataToSend });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao ler banco de dados" });
    }
  });

  // API Route for managers to monitor Firestore Status and Stats
  app.get("/api/firebase/status", async (req, res) => {
    try {
      let config: any = {};
      const configExists = await fs.access(FIREBASE_CONFIG_PATH).then(() => true).catch(() => false);
      if (configExists) {
        const configContent = await fs.readFile(FIREBASE_CONFIG_PATH, "utf-8");
        config = JSON.parse(configContent);
      }
      
      const stats = {
        users: dbCache?.users?.length || 0,
        products: dbCache?.products?.length || 0,
        vehicles: dbCache?.vehicles?.length || 0,
        drivers: dbCache?.drivers?.length || 0,
        audits: dbCache?.audits?.length || 0,
        vales: dbCache?.vales?.length || 0,
        photos: dbCache?.photos?.length || 0,
      };

      res.json({
        success: true,
        firebaseConnected: !!firestoreDb,
        firestoreLoadedSuccessfully,
        firestoreQuotaExceeded,
        firestoreAttemptedConnection,
        storageConnected: !!storageInstance,
        projectId: config.projectId || null,
        databaseId: config.firestoreDatabaseId || "default",
        stats,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao consultar status do Firebase" });
    }
  });

  // API Route to fetch the saved Firebase Web SDK Configuration
  app.get("/api/firebase/config", async (req, res) => {
    try {
      let config: any = {};
      const configExists = await fs.access(FIREBASE_CONFIG_PATH).then(() => true).catch(() => false);
      if (configExists) {
        const configContent = await fs.readFile(FIREBASE_CONFIG_PATH, "utf-8");
        config = JSON.parse(configContent);
      }
      res.json({ success: true, config });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao carregar configurações" });
    }
  });

  // API Route to save configuration and re-initialize Firebase
  app.post("/api/firebase/config", async (req, res) => {
    try {
      const newConfig = req.body;
      if (!newConfig || !newConfig.apiKey || !newConfig.projectId) {
        return res.status(400).json({ success: false, error: "Parâmetros obrigatórios ausentes (apiKey, projectId)" });
      }

      // Write config to file
      await fs.writeFile(FIREBASE_CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf-8");

      // Re-initialize Firebase with the newly saved configuration
      await initFirebase(true);

      res.json({
        success: true,
        firebaseConnected: !!firestoreDb,
        firestoreLoadedSuccessfully,
        firestoreQuotaExceeded,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao salvar e inicializar" });
    }
  });

  // API Route to test a given config in real-time WITHOUT saving it to disk
  app.post("/api/firebase/test", async (req, res) => {
    try {
      const config = req.body;
      if (!config || !config.apiKey || !config.projectId) {
        return res.status(400).json({ success: false, error: "Parâmetros obrigatórios ausentes (apiKey, projectId)" });
      }

      // Initialize a temporary app name to avoid collision
      const testAppName = `test-app-${Date.now()}`;
      const testApp = initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId
      }, testAppName);

      const testDb = initializeFirestore(testApp, {
        experimentalForceLongPolling: true,
      }, config.firestoreDatabaseId || undefined);

      let success = false;
      let errorMsg = null;

      try {
        await Promise.race([
          getDocFromServer(doc(testDb, "test", "connection")),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout validando conexão com Firestore")), 4000))
        ]);
        success = true;
      } catch (err: any) {
        errorMsg = err instanceof Error ? err.message : String(err);
      } finally {
        try {
          await deleteApp(testApp);
        } catch (e) {
          console.warn("Erro ao deletar app Firebase temporário de teste:", e);
        }
      }

      if (success) {
        res.json({ success: true, message: "Conexão estabelecida com sucesso!" });
      } else {
        res.json({ success: false, error: errorMsg || "Não foi possível conectar com as credenciais informadas." });
      }
    } catch (error: any) {
      res.json({ success: false, error: error?.message || "Erro durante o teste de conexão" });
    }
  });

  // API Route to clear/reset the Firebase config
  app.post("/api/firebase/clear", async (req, res) => {
    try {
      const configExists = await fs.access(FIREBASE_CONFIG_PATH).then(() => true).catch(() => false);
      if (configExists) {
        await fs.unlink(FIREBASE_CONFIG_PATH);
      }

      // Re-initialize to clear active states and delete apps
      await initFirebase(true);

      res.json({ success: true, message: "Configuração do Firebase removida com sucesso. Revertido para modo local." });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao remover configuração do Firebase" });
    }
  });

  // API Route to update/save database state
  app.post("/api/db", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      const { db, user } = req.body;
      if (!db) {
        return res.status(400).json({ success: false, error: "Conteúdo do banco de dados não enviado" });
      }
      
      // Merge partial updates into cache
      if (!dbCache) {
        dbCache = {};
      }

      // Generate audit logs
      const logs = generateAuditLogs(dbCache, db, user);
      let allLogs = [...logs, ...(dbCache.audit_logs || [])];
      
      // Prune logs older than 48 hours to conserve space as requested
      const cutoffTime = Date.now() - 48 * 60 * 60 * 1000;
      allLogs = allLogs.filter((log: any) => {
        if (!log.timestamp) return false;
        return new Date(log.timestamp).getTime() >= cutoffTime;
      });
      
      dbCache.audit_logs = allLogs;
      db.audit_logs = dbCache.audit_logs;

      dbCache = { ...dbCache, ...db };

      // Calculate dirty keys (only those present in the request payload, plus audit_logs since they are always updated)
      const dirtyKeys = Array.from(new Set([...Object.keys(db), "audit_logs"])).filter(k => DB_KEYS.includes(k));

      // Write database synchronously to avoid any data loss
      const success = await writeDatabaseFile(dbCache, dirtyKeys);
      if (!success) {
        throw new Error("Falha ao persistir alterações no armazenamento definitivo.");
      }

      // Broadcast real-time update to all connected SSE clients
      if (clients && clients.length > 0) {
        const dataToSend = { ...dbCache };
        delete dataToSend.photos;
        const ssePayload = JSON.stringify({ type: "update", db: dataToSend });
        clients.forEach(client => {
          try {
            client.res.write(`data: ${ssePayload}\n\n`);
          } catch (err) {
            // client disconnected
          }
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Erro ao salvar banco de dados:", error);
      res.status(500).json({ success: false, error: error?.message || "Erro ao salvar banco de dados" });
    }
  });

  // API Route for Atomic Baixa Saga (PDF Generation, Upload to shared folder, and Status update)
  app.post("/api/concluir-baixa", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      const { auditId, pdfBase64, filename, updatedAuditSession, updatedImportedRoutes, updatedAlerts, user } = req.body;

      if (!auditId || !pdfBase64 || !filename || !updatedAuditSession) {
        return res.status(400).json({ success: false, error: "Parâmetros obrigatórios ausentes" });
      }

      // Check idempotency (prevent duplicate operations on already finalized audits)
      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      const existingAudit = (dbCache.audits || []).find((a: any) => a.id === auditId);
      if (existingAudit && (existingAudit.status === 'finalizado_ok' || existingAudit.status === 'finalizado_divergente')) {
        console.log(`[Baixa Saga] Idempotência acionada: O mapa ${updatedAuditSession.routeMap} já se encontra finalizado no banco de dados. Retornando sucesso.`);
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        return res.json({ success: true, filePath: `/Mapas_Baixados/${year}/${month}/${filename}`, info: "Idempotency trigger: already finalized" });
      }

      console.log(`[Baixa Saga] Iniciando saga de baixa para o mapa ${updatedAuditSession.routeMap}...`);

      // 1. Validar PDF base64
      if (pdfBase64.length < 500) {
        return res.status(400).json({ success: false, error: "Arquivo PDF corrompido ou muito curto." });
      }

      // 2. Converter base64 para Buffer
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      if (pdfBuffer.length === 0) {
        return res.status(400).json({ success: false, error: "Falha ao decodificar arquivo PDF." });
      }

      // 3. Estruturar caminhos de rede (ano/mês)
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      
      const destDir = path.join(process.cwd(), "shared_folder", "Mapas_Baixados", year, month);
      await fs.mkdir(destDir, { recursive: true });

      const destPath = path.join(destDir, filename);

      // 4. Gravar arquivo fisicamente na "pasta compartilhada"
      await fs.writeFile(destPath, pdfBuffer);
      console.log(`[Baixa Saga] PDF salvo com sucesso em: ${destPath}`);

      // 5. Validar arquivo gravado
      const stats = await fs.stat(destPath);
      if (stats.size === 0 || stats.size !== pdfBuffer.length) {
        await fs.unlink(destPath).catch(() => {});
        return res.status(500).json({ success: false, error: "Falha de integridade: PDF salvo com tamanho inválido." });
      }

      // 5.1 Tentar backup durável no Firebase Cloud Storage
      let cloudStorageSuccess = false;
      if (storageInstance && !firestoreQuotaExceeded) {
        try {
          console.log(`[Baixa Saga] Enviando PDF de backup para o Firebase Storage em Mapas_Baixados/${year}/${month}/${filename}...`);
          const storageRef = ref(storageInstance, `Mapas_Baixados/${year}/${month}/${filename}`);
          const uint8Array = new Uint8Array(pdfBuffer);
          await Promise.race([
            uploadBytes(storageRef, uint8Array, { contentType: "application/pdf" }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout enviando PDF ao Firebase Storage")), 10000))
          ]);
          console.log(`[Baixa Saga] PDF enviado com sucesso para o Firebase Storage!`);
          cloudStorageSuccess = true;
        } catch (storageErr: any) {
          console.warn(`[Baixa Saga] Falha não bloqueante ao enviar PDF para o Firebase Storage:`, storageErr?.message || storageErr);
          checkQuotaExceeded(storageErr);
        }
      }

      // 6. Atualizar banco de dados de forma atômica
      if (!dbCache) {
        dbCache = {};
      }

      // Merge data
      if (updatedAuditSession) {
        const audits = dbCache.audits || [];
        const exists = audits.some((a: any) => a.id === auditId);
        if (exists) {
          dbCache.audits = audits.map((a: any) => a.id === auditId ? updatedAuditSession : a);
        } else {
          dbCache.audits = [updatedAuditSession, ...audits];
        }
      }

      if (updatedImportedRoutes) {
        dbCache.importedRoutes = updatedImportedRoutes;
      }

      if (updatedAlerts) {
        dbCache.fiscalAlerts = updatedAlerts;
      }

      // Gerar logs de auditoria
      const logs = generateAuditLogs(dbCache, dbCache, user);
      if (logs.length > 0) {
        const existingLogs = dbCache.audit_logs || [];
        dbCache.audit_logs = [...logs, ...existingLogs].slice(0, 1000);
      }

      // Calculate dirty keys for the baixa saga
      const dirtyKeys = ["audits", "audit_logs"];
      if (updatedImportedRoutes) {
        dirtyKeys.push("importedRoutes");
      }
      if (updatedAlerts) {
        dirtyKeys.push("fiscalAlerts");
      }

      // Gravar no armazenamento definitivo
      const writeSuccess = await writeDatabaseFile(dbCache, dirtyKeys);
      if (!writeSuccess) {
        // Rollback PDF se a atualização falhar
        await fs.unlink(destPath).catch(() => {});
        return res.status(500).json({ success: false, error: "Falha ao persistir status de Baixa no banco. PDF deletado da pasta de rede para manter integridade." });
      }

      const firestoreBackupSuccess = (firestoreDb && !firestoreQuotaExceeded) ? true : (firestoreDb ? false : null);

      // Broadcast real-time update to all connected SSE clients
      if (clients && clients.length > 0) {
        const dataToSend = { ...dbCache };
        delete dataToSend.photos;
        const ssePayload = JSON.stringify({ type: "update", db: dataToSend });
        clients.forEach(client => {
          try {
            client.res.write(`data: ${ssePayload}\n\n`);
          } catch (err) {
            // client disconnected
          }
        });
      }

      console.log(`[Baixa Saga] Saga de baixa para o mapa ${updatedAuditSession.routeMap} CONCLUÍDA COM TOTAL SUCESSO!`);
      res.json({ 
        success: true, 
        filePath: `/Mapas_Baixados/${year}/${month}/${filename}`,
        durableBackup: {
          cloudStorage: cloudStorageSuccess,
          firestore: firestoreBackupSuccess
        }
      });

    } catch (err: any) {
      console.error("[Baixa Saga] Erro crítico na execução da saga:", err);
      res.status(500).json({ success: false, error: `Erro crítico na saga de baixa: ${err?.message || err}` });
    }
  });

  // API Route to fetch the list of PDFs in the shared folder
  app.get("/api/shared-pdfs", async (req, res) => {
    try {
      const sharedDir = path.join(process.cwd(), "shared_folder");
      const files = await getFilesRecursively(sharedDir);
      res.json({ success: true, files });
    } catch (err: any) {
      console.error("Erro ao listar PDFs da pasta compartilhada:", err);
      res.status(500).json({ success: false, error: err?.message || "Erro ao obter arquivos" });
    }
  });

  // Direct APK Route Interceptor to force download instead of text rendering in browser
  app.get("/guarabira_acuracidade_v2.1.0.apk", (req, res) => {
    console.log("[Direct APK Request] Interceptando e redirecionando para API de download seguro...");
    res.redirect("/api/download/apk");
  });

  // API Route to download the APK installer
  app.get("/api/download/apk", async (req, res) => {
    try {
      const publicPath = path.join(process.cwd(), "public", "guarabira_acuracidade_v2.1.0.apk");
      const distPath = path.join(process.cwd(), "dist", "guarabira_acuracidade_v2.1.0.apk");
      
      let targetPath = publicPath;
      try {
        await fs.stat(targetPath);
      } catch (e) {
        targetPath = distPath;
        try {
          await fs.stat(targetPath);
        } catch (e2) {
          console.error("Instalador APK não encontrado em nenhuma das pastas:", publicPath, distPath);
          return res.status(404).send("Instalador APK não encontrado no servidor.");
        }
      }

      console.log(`[APK Download] Enviando arquivo de: ${targetPath}`);
      res.setHeader("Content-Disposition", 'attachment; filename="guarabira_acuracidade_v2.1.0.apk"');
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.sendFile(targetPath, (err) => {
        if (err) {
          console.error("Erro ao enviar arquivo APK via Express sendFile:", err);
          if (!res.headersSent) {
            res.status(500).send("Erro ao processar o download do arquivo APK.");
          }
        }
      });
    } catch (err: any) {
      console.error("Erro crítico na API de download do APK:", err);
      res.status(500).send("Erro interno ao processar download do APK.");
    }
  });

  // API Route to fetch photos
  app.get("/api/photos", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      const { auditId } = req.query;

      // If Firestore is active, query it to ensure the server is fully up to date with any direct client-side photo uploads
      if (firestoreDb && !firestoreQuotaExceeded && auditId) {
        try {
          const { query, where, getDocs, collection } = await import("firebase/firestore");
          const photosCol = collection(firestoreDb, "photos");
          const q = query(photosCol, where("auditId", "==", auditId));
          const snap = await getDocs(q);
          const fsPhotos: any[] = [];
          snap.forEach((docSnap) => {
            fsPhotos.push(docSnap.data());
          });

          if (fsPhotos.length > 0) {
            if (!dbCache.photos) dbCache.photos = [];
            const existingPhotosMap = new Map(dbCache.photos.map((p: any) => [p.id, p]));
            fsPhotos.forEach(p => {
              existingPhotosMap.set(p.id, p);
            });
            dbCache.photos = Array.from(existingPhotosMap.values());
            await writeDatabaseFile(dbCache, []);
          }
        } catch (fsErr) {
          console.warn("[Server] Erro ao buscar fotos sincronizadas do Firestore:", fsErr);
        }
      }

      let photos = dbCache.photos || [];
      if (auditId) {
        photos = photos.filter((p: any) => p.auditId === auditId);
      }
      res.json({ success: true, photos });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao obter fotos" });
    }
  });

  // API Route to save/update a photo
  app.post("/api/photos", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      const { photo } = req.body;
      if (!photo) {
        return res.status(400).json({ success: false, error: "Foto não enviada" });
      }

      const originalUrl = photo.photoUrl;

      // If photoUrl starts with "data:" (is base64), upload it to Storage/disk first
      if (originalUrl && originalUrl.startsWith("data:")) {
        console.log(`Recebida nova imagem base64 para foto ID: ${photo.id}. Fazendo upload...`);
        const savedUrl = await uploadPhotoToStorageAndGetUrl(photo.id, originalUrl);
        photo.photoUrl = savedUrl; // Store only the clean reference URL instead of huge base64
      }

      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      if (!dbCache.photos) {
        dbCache.photos = [];
      }
      
      const index = dbCache.photos.findIndex((p: any) => p.id === photo.id);
      if (index > -1) {
        dbCache.photos[index] = photo;
      } else {
        dbCache.photos.push(photo);
      }

      await writeDatabaseFile(dbCache, []);

      // Sincroniza foto individual no Firestore (contendo o URL enxuto, não o base64 gigante!)
      if (firestoreDb && !firestoreQuotaExceeded) {
        try {
          const docRef = doc(firestoreDb, "photos", photo.id);
          await setDoc(docRef, photo);
        } catch (setErr: any) {
          console.warn("Erro ao sincronizar foto no Firestore:", setErr?.message || setErr);
          checkQuotaExceeded(setErr);
        }
      }

      res.json({ success: true, photo });
    } catch (error: any) {
      console.warn("Erro na rota de salvamento de foto:", error);
      res.status(500).json({ success: false, error: error?.message || "Erro ao salvar foto" });
    }
  });

  // API Route to delete a photo
  app.delete("/api/photos/:id", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      const { id } = req.params;

      // Delete from physical storage (local file + Firebase Storage)
      await deletePhotoFromStorage(id).catch(() => {});

      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      if (dbCache.photos) {
        dbCache.photos = dbCache.photos.filter((p: any) => p.id !== id);
        await writeDatabaseFile(dbCache, []);
      }

      // Deleta foto individual no Firestore
      if (firestoreDb && !firestoreQuotaExceeded) {
        try {
          const { deleteDoc } = await import("firebase/firestore");
          const docRef = doc(firestoreDb, "photos", id);
          await deleteDoc(docRef);
        } catch (delErr: any) {
          console.warn("Erro ao deletar foto do Firestore:", delErr?.message || delErr);
          checkQuotaExceeded(delErr);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao deletar foto" });
    }
  });

  // API Route to clear all photos
  app.post("/api/photos/clear", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }

      // Deleta todas as fotos físicas locais de uma vez
      try {
        const localDir = path.join(process.cwd(), "shared_folder", "photos");
        await fs.rm(localDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(localDir, { recursive: true }).catch(() => {});
      } catch (err) {
        // ignore
      }

      dbCache.photos = [];
      await writeDatabaseFile(dbCache, []);

      // Limpa todas as fotos individuais no Firestore
      if (firestoreDb && !firestoreQuotaExceeded && firestoreLoadedSuccessfully) {
        try {
          const { deleteDoc } = await import("firebase/firestore");
          const photosCol = collection(firestoreDb, "photos");
          const snap = await getDocs(photosCol);
          let deletedCount = 0;
          for (const d of snap.docs) {
            if (firestoreQuotaExceeded) {
              console.log("[Clear Photos] Cota do Firestore excedida durante a limpeza. Abortando loop de deleção.");
              break;
            }
            await deleteDoc(d.ref);
            deletedCount++;
          }
          if (deletedCount > 0) {
            console.log(`[Clear Photos] Limpas com sucesso ${deletedCount} fotos no Firestore.`);
          }
        } catch (err: any) {
          console.warn("Erro ao limpar fotos do Firestore:", err);
          checkQuotaExceeded(err);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao limpar fotos" });
    }
  });

  // API Route to prune photos
  app.post("/api/photos/prune", async (req, res) => {
    try {
      await ensureDatabaseSynced();
      const { daysRetention } = req.body;
      const days = Number(daysRetention) || 30;
      if (!dbCache) {
        const db = await readDatabaseFile();
        dbCache = db || {};
      }
      if (dbCache.photos) {
        const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
        const toKeep = dbCache.photos.filter((p: any) => new Date(p.timestamp).getTime() >= cutoffMs);
        const toPrune = dbCache.photos.filter((p: any) => new Date(p.timestamp).getTime() < cutoffMs);
        
        // Clean up from Storage and local disk
        for (const p of toPrune) {
          await deletePhotoFromStorage(p.id).catch(() => {});
        }

        dbCache.photos = toKeep;
        const prunedCount = toPrune.length;
        
        await writeDatabaseFile(dbCache, []);

        // Deleta as fotos podadas no Firestore
        if (firestoreDb && !firestoreQuotaExceeded && firestoreLoadedSuccessfully && prunedCount > 0) {
          try {
            const { deleteDoc } = await import("firebase/firestore");
            let deletedCount = 0;
            for (const p of toPrune) {
              if (firestoreQuotaExceeded) {
                console.log("[Photo Pruning Route] Cota do Firestore excedida durante o processamento. Abortando loop de exclusão.");
                break;
              }
              const docRef = doc(firestoreDb, "photos", p.id);
              await deleteDoc(docRef);
              deletedCount++;
            }
            if (deletedCount > 0) {
              console.log(`[Photo Pruning Route] Podadas com sucesso ${deletedCount} fotos no Firestore.`);
            }
          } catch (err: any) {
            console.warn("Erro ao podar fotos do Firestore:", err);
            checkQuotaExceeded(err);
          }
        }

        res.json({ success: true, prunedCount });
      } else {
        res.json({ success: true, prunedCount: 0 });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Erro ao podar fotos" });
    }
  });

  // API Route for Gemini AI Chat
  app.post("/api/chat", async (req, res) => {
    try {
      const { message, history } = req.body;
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ 
          error: "Chave API não configurada. Configure a chave GEMINI_API_KEY no painel de Configurações > Secrets." 
        });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Fetch active dynamic context from local database file
      let activeDatabaseContext = "Nenhum dado ativo no momento.";
      try {
        const db = await readDatabaseFile();
        if (db) {
          const routes = db.importedRoutes || [];
          const audits = db.audits || [];
          const vales = db.vales || [];
          const drivers = db.drivers || [];

          const openRoutes = routes.filter((r: any) => r.status !== 'fechado');
          const closedRoutes = routes.filter((r: any) => r.status === 'fechado');

          const valesPendentes = vales.filter((v: any) => v.status === 'PENDENTE_ASSINATURA');
          const valesAssinados = vales.filter((v: any) => v.status === 'ASSINADO');
          const valesCompensados = vales.filter((v: any) => v.status === 'COMPENSADO');

          activeDatabaseContext = `
DADOS ATIVOS EM TEMPO REAL DA UNIDADE:
- Rotas Importadas Totais: ${routes.length} (Abertas: ${openRoutes.length}, Fechadas: ${closedRoutes.length})
- Rotas em Aberto no momento: ${openRoutes.map((r: any) => `Mapa ${r.routeMap} (Placa ${r.plate}, Status ${r.status})`).join(', ') || 'Nenhuma'}
- Auditorias com Divergência Registradas: ${audits.filter((a: any) => a.status === 'finalizado_divergente').length}
- Vales de Colaboradores: Total de ${vales.length} vales.
  * Pendentes de assinatura: ${valesPendentes.length} vales (Total R$ ${valesPendentes.reduce((acc: number, curr: any) => acc + (curr.valor || 0), 0).toFixed(2)})
  * Assinados: ${valesAssinados.length} vales (Total R$ ${valesAssinados.reduce((acc: number, curr: any) => acc + (curr.valor || 0), 0).toFixed(2)})
  * Compensados/Descontados: ${valesCompensados.length} vales

Detalhes de Auditorias Ativas com Divergências de Sobras/Faltas de PA (Produto Acabado) e AG (Ativo de Giro):
${audits.map((a: any) => {
  const driverName = drivers.find((d: any) => d.id === a.driverId)?.name || 'Desconhecido';
  const surplusPA = a.items.filter((i: any) => (i.rePhysicalQty ?? i.physicalQty) > (i.fiscalQty ?? 0));
  const deficitPA = a.items.filter((i: any) => (i.rePhysicalQty ?? i.physicalQty) < (i.fiscalQty ?? 0));
  const surplusAG = a.assets.filter((as: any) => (as.rePhysicalQty ?? as.physicalQty) > (as.fiscalQty ?? 0));
  const deficitAG = a.assets.filter((as: any) => (as.rePhysicalQty ?? as.physicalQty) < (as.fiscalQty ?? 0));

  let info = `* Mapa ${a.routeMap} (Placa: ${a.plate}, Motorista: ${driverName}, Status Geral: ${a.status}):\n`;
  if (surplusPA.length > 0) {
    info += `  - Sobras de PA (Produto Acabado): ${surplusPA.map((i: any) => `${i.productDescription} (+${(i.rePhysicalQty ?? i.physicalQty) - (i.fiscalQty ?? 0)} un)`).join(', ')}\n`;
  }
  if (deficitPA.length > 0) {
    info += `  - Faltas de PA (Produto Acabado): ${deficitPA.map((i: any) => `${i.productDescription} (-${(i.fiscalQty ?? 0) - (i.rePhysicalQty ?? i.physicalQty)} un)`).join(', ')}\n`;
  }
  if (surplusAG.length > 0) {
    info += `  - Sobras de AG (Ativo de Giro): ${surplusAG.map((as: any) => `${as.assetName} (+${(as.rePhysicalQty ?? as.physicalQty) - (as.fiscalQty ?? 0)} un)`).join(', ')}\n`;
  }
  if (deficitAG.length > 0) {
    info += `  - Faltas de AG (Ativo de Giro): ${deficitAG.map((as: any) => `${as.assetName} (-${(as.fiscalQty ?? 0) - (as.rePhysicalQty ?? as.physicalQty)} un)`).join(', ')}\n`;
  }
  if (a.correctiveActionNotes) {
    info += `  - Observação/Ação Corretiva: "${a.correctiveActionNotes}"\n`;
  }
  return info;
}).join('\n') || 'Nenhuma auditoria com divergência registrada no momento.'}

Lista de Vales de Faltas Gerados na Unidade por Colaborador:
${vales.map((v: any) => `- Vale ID: ${v.id} | Colaborador: ${v.colaboradorName} (${v.colaboradorRole}) | Valor: R$ ${v.valor.toFixed(2)} | Motivo: ${v.descricao} | Status: ${v.status} | Obs: ${v.observacao || 'Sem observação'}`).join('\n') || 'Nenhum vale gerado.'}
`;
        }
      } catch (dbError) {
        console.error("Erro ao ler dados dinâmicos do banco para IA:", dbError);
      }

      const systemInstruction = `Você é o Assistente Virtual Inteligente da plataforma "Aferição de Retorno de Rota - Pau Brasil Distribuidora Ambev". 
Seu papel é tirar dúvidas dos usuários de forma prestativa, direta, simples e profissional, dando respostas EXTREMAMENTE ASSERTIVAS baseadas nos dados ativos e reais de faturamento e divergências da unidade.

Sobre a plataforma:
- A plataforma gerencia o retorno dos caminhões de rota da Pau Brasil Distribuidora Ambev.
- Existem 4 perfis/funções principais:
  1. Conferente de Pátio: Faz a contagem física (produtos e ativos como paletes/chapas/garrafeiras) dos caminhões que retornam. Pode pausar a conferência com justificativa se necessário.
  2. Auxiliar de Logística (Fiscal): Faz a conciliação/reconciliação fiscal comparando a contagem física do Conferente com o faturamento fiscal. Pode aprovar, aprovar com sobras/faltas ou solicitar recontagem (nova conferência) caso as divergências sejam injustificáveis. Também pode sincronizar planilhas.
  3. Monitoramento: Define previsões de chegada (ETA), tripStatus (se retorna no dia ou pernoita), observações de rota e monitora as viagens em tempo real.
  4. Gestor Master: Tem acesso ao Painel Gerencial (KPIs, tempos médios, produtividade) e Guias de Cadastro (gerenciar Motoristas, Veículos, Produtos e Usuários).

Regras de Negócio Importantes:
- PERNOITE: Quando um caminhão não retorna no mesmo dia e pernoita fora da distribuidora. O monitoramento atualiza isso para sinalizar ao pátio.
- RECONTAL / SOLICITAR RECONTAGEM: Quando o Fiscal identifica que a divergência está fora do aceitável, ele pode recusar e pedir que o Conferente refaça a contagem daquele item ou do mapa inteiro.
- PAUSA DE CONFERÊNCIA: O Conferente pode pausar uma conferência ativa por motivos urgentes (ex: ir ao banheiro, parada técnica, etc.), fornecendo uma observação obrigatória. Esta tela agora está totalmente visível e funcional.
- SOBRAS & FALTAS PA/AG: Divididos de forma organizada em Produtos Acabados (PA) e Ativos de Giro (AG). São as discrepâncias físicas versus fiscais geradas após a contagem.
- CONTROLE DE VALES: Quando ocorrem faltas físicas de mercadoria, pode ser gerado um Vale (desconto/compensação) com histórico de vales gerados para cada colaborador para controle do financeiro/gestão.

Aqui estão os dados operacionais ATIVOS da unidade em tempo real para responder de forma super precisa:
---------------------------
${activeDatabaseContext}
---------------------------

Instruções para Resposta:
- Seja amigável e responda em Português do Brasil de forma clara, prestativa e estruturada.
- Use as informações de dados em tempo real acima para responder com fatos exatos, valores de vales e motoristas com problemas, sempre que o usuário perguntar por "dados", "quem está pendente", "quais sobras", "quais vales", etc.
- Dê passos-a-passos objetivos.
- Evite jargões técnicos excessivos do código, foque no fluxo de negócio da distribuidora Ambev.`;

      // Format history into structure expected by generateContent
      const contents = [];
      
      if (history && Array.isArray(history)) {
        for (const turn of history) {
          contents.push({
            role: turn.role === 'user' ? 'user' : 'model',
            parts: [{ text: turn.text }]
          });
        }
      }
      
      // Add the latest message
      contents.push({
        role: 'user',
        parts: [{ text: message }]
      });

      let response;
      try {
        console.log("Tentando gerar resposta com gemini-3.5-flash...");
        response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: contents,
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.1,
          }
        });
      } catch (firstError: any) {
        console.warn("Falha no gemini-3.5-flash, tentando fallback para gemini-3.1-flash-lite...", firstError?.message || firstError);
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: contents,
            config: {
              systemInstruction: systemInstruction,
              temperature: 0.1,
            }
          });
        } catch (secondError: any) {
          console.warn("Falha no gemini-3.1-flash-lite, tentando fallback para gemini-2.5-flash...", secondError?.message || secondError);
          response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
              systemInstruction: systemInstruction,
              temperature: 0.1,
            }
          });
        }
      }

      const replyText = response.text || "Desculpe, não consegui processar a resposta.";
      res.json({ text: replyText });
    } catch (error: any) {
      console.error("Erro na rota de chat:", error);
      res.status(500).json({ error: error?.message || "Ocorreu um erro ao processar sua solicitação com a inteligência artificial." });
    }
  });

  // Vite middleware or Static files
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Encerramento gracioso (SIGTERM/SIGINT) para garantir a consistência absoluta dos dados
async function handleGracefulShutdown(signal: string) {
  console.log(`\n[Shutdown] Recebido sinal ${signal}. Iniciando encerramento gracioso...`);
  try {
    // Esperar a fila de escrita atual terminar
    console.log("[Shutdown] Aguardando a conclusão da fila de gravação atual...");
    await writeQueuePromise;

    if (dbCache) {
      console.log("[Shutdown] Executando sincronização final completa de app_state com o Firestore...");
      // Força um último writeDatabaseFile com sincronização completa
      const success = await writeDatabaseFile(dbCache, DB_KEYS);
      if (success) {
        console.log("[Shutdown] Sincronização final realizada com sucesso.");
      } else {
        console.warn("[Shutdown] Sincronização final falhou ou foi abortada.");
      }
    }
  } catch (err: any) {
    console.error("[Shutdown] Erro durante o encerramento gracioso:", err);
  } finally {
    console.log("[Shutdown] Processo finalizado de forma segura.");
    process.exit(0);
  }
}

process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));

startServer();
