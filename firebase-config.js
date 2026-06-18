// 1. Firebase kütüphanelerini import et
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

// 2. Firebase yapılandırma bilgilerin
const firebaseConfig = {
  apiKey: "s3ddhcea9xae0qieikgjy9zw9tduemnraoucjrr9iqe87pduhczmd95kq8n3aai1",
  authDomain: "web3-domain-gateway.firebaseapp.com",
  projectId: "web3-domain-gateway",
  storageBucket: "web3-domain-gateway.firebasestorage.app",
  messagingSenderId: "315563254318",
  appId: "1:315563254318:web:12f2f3f340bb69606df5bf",
  measurementId: "G-1MC05YBPCC"
};

// 3. Uygulamayı başlat
const app = initializeApp(firebaseConfig);

// 4. Analitiği başlat
const analytics = getAnalytics(app);

// Bu değişkenleri projenin diğer sayfalarında kullanabilmek için dışa aktar
export { app, analytics };
