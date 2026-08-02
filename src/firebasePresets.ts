export interface FirebasePreset {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  description: string;
  config: {
    projectId: string;
    appId: string;
    apiKey: string;
    authDomain: string;
    firestoreDatabaseId: string;
    storageBucket: string;
    messagingSenderId: string;
    measurementId?: string;
    oAuthClientId?: string;
  };
}

export const FIREBASE_PRESETS: FirebasePreset[] = [
  {
    id: "armazemfacil-b2292",
    name: "Banco Principal",
    badge: "Oficial",
    badgeColor: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    description: "armazemfacil-b2292 (Banco Oficial do Sistema)",
    config: {
      projectId: "armazemfacil-b2292",
      appId: "1:688234941301:web:afd418d38c7d7750e3213c",
      apiKey: "AIzaSyA_ykhJGRklDbPuDNYooMlVvB2DeVzp2VE",
      authDomain: "armazemfacil-b2292.firebaseapp.com",
      firestoreDatabaseId: "(default)",
      storageBucket: "armazemfacil-b2292.firebasestorage.app",
      messagingSenderId: "688234941301",
      measurementId: "",
      oAuthClientId: ""
    }
  },
  {
    id: "sstr-7dd45",
    name: "Banco Secundário",
    badge: "SSTR",
    badgeColor: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    description: "sstr-7dd45 (Banco de Suporte e Integração SSTR)",
    config: {
      projectId: "sstr-7dd45",
      appId: "1:997661072530:web:338293e8fa584a934eda4b",
      apiKey: "AIzaSyCFpHeTCT9pxryljNDps2IVEA3l89cTpLk",
      authDomain: "sstr-7dd45.firebaseapp.com",
      firestoreDatabaseId: "(default)",
      storageBucket: "sstr-7dd45.firebasestorage.app",
      messagingSenderId: "997661072530",
      measurementId: "",
      oAuthClientId: ""
    }
  }
];

export function getActivePresetId(projectId?: string): string {
  if (!projectId) return "custom";
  const matched = FIREBASE_PRESETS.find(p => p.config.projectId === projectId);
  return matched ? matched.id : "custom";
}
