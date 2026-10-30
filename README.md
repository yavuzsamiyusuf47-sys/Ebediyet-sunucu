# Ebediyet Multiplayer Sunucusu

Bu depo, Ebediyet Krallık Savaşları oyununun 2-4 kişilik multiplayer sunucusudur.

## Render kurulumu

1. GitHub'da bu üç dosyayı yükle: `server.js`, `package.json`, `render.yaml`.
2. Render hesabına GitHub ile giriş yap.
3. **New +** → **Web Service** seç.
4. GitHub deponu seç.
5. Plan olarak **Free** seç.
6. **Create Web Service** düğmesine bas.
7. Deploy bitince Render'ın verdiği adresi kopyala.
8. Adresin başına `wss://` ekle. Örnek: `wss://ebediyet-multiplayer.onrender.com`
9. Bu adresi oyunun Çok Oyunculu ekranındaki **Sunucu adresi** kutusuna yaz.
10. Bir telefonda **Oda Kur**, diğer telefonda aynı kodla **Odaya Katıl**.

## Not

Render ücretsiz servisi 15 dakika boyunca istek almazsa uyur. İlk bağlantı biraz geç açılabilir.
