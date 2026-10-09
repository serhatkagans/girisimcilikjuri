# ETKİM Genç Tekno Girişimcilik Kampı — Demo Day Jüri Sistemi

Beş jürinin 20 ili yedi kritere göre puanladığı, sonuçların ana ekranda canlı ve
efektli gösterildiği web uygulaması. Bağımlılık yok: Node.js 22.13+ yeterli
(veritabanı Node'un yerleşik SQLite modülü).

## Çalıştırma

1. `.env.example` dosyasını `.env` olarak kopyalayın, `JURI_SIFRE` değerini yazın.
2. `baslat.bat` (ya da `npm start`).

| Adres | Ne |
|---|---|
| `http://localhost:3000/` | Ana ekran: canlı sıralama, giriş gerekmez |
| `http://localhost:3000/juri` | Jüri paneli (telefona uyumlu): kullanıcı adı isim+soyisim bitişik, küçük harf (ör. `alidemir`) |

## Puanlama

| Kriter | Puan |
|---|---|
| Girişimcilik (fikrin inovatif yönü) | 1–10 |
| Ekip Kurma Becerisi | 1–15 |
| Yenilikçi Fikirler Sunma ve Ürünler Tasarlayabilme | 1–15 |
| Risk Yönetimi | 1–15 |
| Kanvas İş Modeli oluşturma | 1–15 |
| Girişimine Finansman Kaynak Bulma / Yönetme | 1–15 |
| Geliştirilen Fikrin (Girişimin) Sunumu | 1–15 |

Bir jürinin bir ile verebileceği en yüksek puan 100. Ana ekranda puan veren jürilerin
ortalaması gösterilir; ile tıklayınca beş jürinin kriter kriter puanları açılır.
Her jüri kendi puanını istediği zaman değiştirebilir ya da silebilir.

## Ana ekran

- **Şimdi sahnede:** sunum sırası `server.js` içindeki `GROUPS` listesidir. Beş jürinin
  hepsinin oy vermediği ilk il sahnede sayılır; beşi de oy verince ekran sıradaki ile geçer.
  Kartta kaç jürinin oy verdiği ve kimlerin beklendiği görünür.
- **Sunum bekliyor:** henüz hiç oy almamış iller sıralamada soluk görünür.
- **Alt bant:** `.env` içindeki `ETKINLIK_TARIH` ve `ETKINLIK_YER` ile saat gösterilir.
  Destekçi logoları için PNG/JPG/SVG dosyalarını `public/logolar/` klasörüne koyun
  (dosya adına göre sıralanır, sunucuyu yeniden başlatmak gerekmez; ekranı yenileyin).

## Puanları indirme (XLSX)

Ana ekrandaki **⬇ XLSX indir** butonu (ya da doğrudan `http://localhost:3000/puanlar.xlsx`)
o anki puanlarla bir Excel dosyası indirir; etkinlik boyunca istenildiği kadar indirilebilir.

- **Sıralama** sayfası: sıra, il, takım, ortalama, oy veren jüri sayısı ve her jürinin toplam puanı
- **Jüri Ayrıntısı** sayfası: sunum sırasına göre her il için beş jürinin kriter kriter puanları,
  oy zamanı ve kriter ortalamaları

Takım isimleri `server.js` içindeki `TEAMS` listesindedir; ekranlarda il adının yanında görünür.

## Veri

Oylar `juri.db` (SQLite) dosyasında. Sıfırlamak için sunucuyu durdurup dosyayı silin.
