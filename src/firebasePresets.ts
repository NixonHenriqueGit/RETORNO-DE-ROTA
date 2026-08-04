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
    id: "banco-02",
    name: "Banco Principal (banco-02)",
    badge: "Principal",
    badgeColor: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    description: "banco-02 (Banco Principal do Sistema)",
    config: {
      projectId: "banco-02",
      appId: "1:371160154801:web:d0ace42812cae638789890",
      apiKey: "AIzaSyDRhTutIot6LBtNqMb5G2ES4Oe_--bQV9w",
      authDomain: "banco-02.firebaseapp.com",
      firestoreDatabaseId: "(default)",
      storageBucket: "banco-02.firebasestorage.app",
      messagingSenderId: "371160154801",
      measurementId: "",
      oAuthClientId: ""
    }
  },
  {
    id: "armazemfacil-b2292",
    name: "Armazém Fácil",
    badge: "Anterior",
    badgeColor: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    description: "armazemfacil-b2292 (Banco de Dados Anterior)",
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
    id: "abastecimento-78ae9",
    name: "Banco Abastecimento",
    badge: "Abastecimento",
    badgeColor: "bg-purple-500/15 text-purple-600 border-purple-500/30",
    description: "abastecimento-78ae9 (Banco de Abastecimento)",
    config: {
      projectId: "abastecimento-78ae9",
      appId: "1:527386679510:web:eb890096aacc0aed079177",
      apiKey: "AIzaSyBLjKJ-Lfp692yBF1uHIgtPfcGoUoBwvJ0",
      authDomain: "abastecimento-78ae9.firebaseapp.com",
      firestoreDatabaseId: "(default)",
      storageBucket: "abastecimento-78ae9.firebasestorage.app",
      messagingSenderId: "527386679510",
      measurementId: "",
      oAuthClientId: ""
    }
  },
  {
    id: "sstr-7dd45",
    name: "Banco SSTR",
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
