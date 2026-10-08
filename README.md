# Girişimcilik Jüri Değerlendirme Sistemi

Üç jürinin 20 grubu yedi kritere göre puanladığı, sonuçların ana ekranda canlı ve
efektli gösterildiği web uygulaması. Bağımlılık yok: Node.js 22.13+ yeterli
(veritabanı Node'un yerleşik SQLite modülü).

## Çalıştırma

1. `.env.example` dosyasını `.env` olarak kopyalayın, `JURI_SIFRE` değerini yazın.
2. `baslat.bat` (ya da `npm start`).

| Adres | Ne |
|---|---|
| `http://localhost:3000/` | Ana ekran: canlı sıralama, giriş gerekmez |
| `http://localhost:3000/juri` | Jüri paneli: `juri1`, `juri2`, `juri3` |

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

Bir jürinin bir gruba verebileceği en yüksek puan 100, grubun toplamı en fazla 300.
Her jüri kendi puanını istediği zaman değiştirebilir ya da silebilir.

## Veri

Oylar `juri.db` (SQLite) dosyasında. Sıfırlamak için sunucuyu durdurup dosyayı silin.
