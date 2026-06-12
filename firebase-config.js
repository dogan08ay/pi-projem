// Firebase SDK importları
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

// Firebase yapılandırma bilgileri
const firebaseConfig = {
  apiKey: "AIzaSyC9r244vRVGbYOcLHyS6EHxKyiygajW7_A",
  authDomain: "web3-domain-gateway.firebaseapp.com",
  projectId: "web3-domain-gateway",
  storageBucket: "web3-domain-gateway.firebasestorage.app",
  messagingSenderId: "315563254318",
  appId: "1:315563254318:web:12f2f3f340bb69606df5bf",
  measurementId: "G-1MC05YBPCC"
};

// Uygulamayı ve Analitiği başlatma
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Diğer dosyalarda kullanabilmek için dışa aktarma
export { app, analytics };
