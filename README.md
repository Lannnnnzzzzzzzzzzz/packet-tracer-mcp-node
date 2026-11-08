<div align="center">

# Packet Tracer MCP Node

### Bangun topologi jaringan. Validasi rancangannya. Siapkan konfigurasi Cisco IOS.

Hubungkan client AI yang mendukung **Model Context Protocol (MCP)** dengan alur kerja Cisco Packet Tracer鈥攎ulai dari perencanaan hingga deployment melalui bridge lokal.

<br>

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-43853D?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-MCP-5965E0)](https://modelcontextprotocol.io/)
[![Tools](https://img.shields.io/badge/MCP%20Tools-98-263445)](src/adapters/mcp/tool_defs.json)
[![License](https://img.shields.io/badge/License-MIT-248A70)](LICENSE)

<br>

[Mulai dalam 3 langkah](#mulai-cepat)銆�路銆�[Fitur](#apa-yang-bisa-dilakukan)銆�路銆�[Hubungkan Packet Tracer](#hubungkan-ke-packet-tracer)銆�路銆�[Pengembangan](#pengembangan)

</div>

---

<table>
  <tr>
    <td colspan="3" align="center">
      <strong>Satu MCP server, dari ide jaringan sampai proyek siap dijalankan.</strong><br>
      Perencanaan dan pembuatan konfigurasi dapat dilakukan tanpa Packet Tracer terbuka. Untuk mengubah topologi secara langsung, aktifkan extension MCP Control Center.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <strong>01 路 Rancang</strong><br><br>
      Susun topologi, pilih perangkat, dan rencanakan koneksi serta alamat IP berdasarkan katalog yang tersedia.
    </td>
    <td width="33%" valign="top">
      <strong>02 路 Validasi</strong><br><br>
      Periksa rancangan, temukan masalah, lalu minta perbaikan sebelum konfigurasi atau deployment.
    </td>
    <td width="33%" valign="top">
      <strong>03 路 Jalankan</strong><br><br>
      Hasilkan konfigurasi dan skrip; bila bridge aktif, kirim perubahan langsung ke Packet Tracer.
    </td>
  </tr>
</table>

## Apa yang bisa dilakukan

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Rancang topologi</h3>
      Buat rancangan jaringan, estimasi perangkat, validasi koneksi dan alamat IP, serta perbaiki masalah yang ditemukan.
    </td>
    <td width="50%" valign="top">
      <h3>Hasilkan konfigurasi</h3>
      Siapkan konfigurasi CLI Cisco IOS dan skrip JavaScript Packet Tracer untuk perangkat maupun topologi.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Kelola proyek live</h3>
      Dengan bridge aktif, tambahkan atau ubah perangkat dan link, jalankan konfigurasi, periksa topologi, lalu simpan atau buka proyek.
    </td>
    <td width="50%" valign="top">
      <h3>Jelajahi fitur jaringan</h3>
      Tersedia tools untuk routing, switching, VLAN, ACL, NAT, keamanan, layanan, wireless, simulasi, traffic, convergence, project, dan canvas.
    </td>
  </tr>
</table>

## Mulai cepat

### 1. Pastikan prasyarat

| Kebutuhan | Keterangan |
| --- | --- |
| Node.js | Versi **20 atau lebih baru**, beserta npm |
| Client MCP | Client yang mendukung MCP, misalnya Claude Code |
| Packet Tracer | **Opsional** untuk perencanaan; versi **8.2 atau lebih baru** dan extension MCP Control Center diperlukan untuk operasi langsung |

### 2. Clone dan pasang dependensi

```bash
git clone https://github.com/Lannnnnzzzzzzzzzzz/packet-tracer-mcp-node.git
cd packet-tracer-mcp-node
npm install
```

### 3. Daftarkan server ke Claude Code

Ganti path contoh dengan lokasi folder hasil clone di komputer Anda:

```bash
claude mcp add packet-tracer -- node "/path/to/packet-tracer-mcp-node/src/index.js" --stdio
```

Atau tambahkan konfigurasi project berikut ke file `.mcp.json` pada folder project client:

```json
{
  "mcpServers": {
    "packet-tracer": {
      "command": "node",
      "args": ["/path/to/packet-tracer-mcp-node/src/index.js", "--stdio"]
    }
  }
}
```

Di Windows, gunakan path absolut, misalnya `C:\\Users\\Nama\\packet-tracer-mcp-node\\src\\index.js`. Dalam file JSON, setiap backslash harus ditulis dua kali. Lihat [panduan setup Windows](SETUP-WINDOWS.md) untuk petunjuk lengkap, termasuk instalasi extension dan troubleshooting.

### Pilih cara menjalankan

| Cara | Perintah | Cocok untuk |
| --- | --- | --- |
| **stdio** | `npm start` | Client MCP lokal; transport default untuk konfigurasi di atas |
| **Streamable HTTP** | `node src/index.js` | Akses melalui HTTP lokal pada `127.0.0.1:39400` |

Untuk menjalankan mode stdio secara eksplisit, gunakan `node src/index.js --stdio`.

## Hubungkan ke Packet Tracer

Koneksi langsung menggunakan extension **MCP Control Center** dan bridge lokal.

<table>
  <tr>
    <td width="48" align="center"><strong>1</strong></td>
    <td>Unduh <code>MCP-Control-Center.pts</code> dari <a href="https://github.com/Lannnnnzzzzzzzzzzz/packet-tracer-mcp-node/releases/latest">rilis terbaru</a>.</td>
  </tr>
  <tr>
    <td align="center"><strong>2</strong></td>
    <td>Letakkan file tersebut di subfolder <code>extensions/MCPControlCenter/</code> dalam folder instalasi Packet Tracer.</td>
  </tr>
  <tr>
    <td align="center"><strong>3</strong></td>
    <td>Buka kembali Packet Tracer, setujui module baru bila diminta, lalu pilih <strong>Extensions 鈫� MCP BUILDER</strong>.</td>
  </tr>
  <tr>
    <td align="center"><strong>4</strong></td>
    <td>Pastikan MCP server berjalan, lalu panggil <code>pt_bridge_status</code> dari client untuk memeriksa koneksi.</td>
  </tr>
</table>

Token bridge dikelola otomatis鈥攖idak perlu menyalin atau memasangkannya secara manual. Bridge Packet Tracer memakai port **54321**; Streamable HTTP memakai **39400**. Untuk detail lokasi file berdasarkan sistem operasi, lihat [panduan setup Windows](SETUP-WINDOWS.md) atau source extension di [`extension/`](extension/).

## Alur kerja yang disarankan

Mulailah dengan memeriksa katalog perangkat dan port agar rancangan memakai model serta koneksi yang benar-benar tersedia.

```text
pt_list_devices
      鈫�
pt_plan_topology
      鈫�
pt_validate_plan
      鈫�
pt_fix_plan                 jika ditemukan masalah
      鈫�
pt_generate_configs         atau pt_generate_script
      鈫�
pt_live_deploy              jika Packet Tracer terhubung
```

Untuk memeriksa detail sebelum merancang:

- `pt_list_devices` 鈥� lihat perangkat dan model yang tersedia.
- `pt_get_device_details` 鈥� periksa detail model tertentu.
- `pt_list_templates` 鈥� lihat template topologi.
- `pt_list_modules` 鈥� periksa modul ekspansi sebelum digunakan.

Untuk alur terpadu, gunakan `pt_full_build` guna merencanakan, memvalidasi, menghasilkan artefak, dan menyiapkan deployment. Operasi langsung memerlukan Packet Tracer yang terhubung melalui extension.

### Contoh permintaan

> Rancang topologi dengan tiga router berantai dan satu LAN di setiap lokasi. Siapkan DHCP dan OSPF, lalu periksa model serta port yang tersedia sebelum membuat rancangan.

Client MCP akan memilih tools yang sesuai untuk memeriksa katalog, merencanakan dan memvalidasi topologi, lalu menghasilkan konfigurasi atau menerapkan perubahan jika bridge aktif.

## Direktori kerja

Secara default, ekspor, screenshot, dan proyek disimpan di `~/PacketTracerMCP`. Atur `PT_MCP_WORKDIR` untuk menggunakan lokasi lain:

```bash
PT_MCP_WORKDIR="$HOME/Documents/PacketTracerMCP" npm start
```

## Pengembangan

```bash
npm test
```

Test menggunakan Node.js Test Runner. Untuk status porting dan catatan kompatibilitas, lihat [PORTING_STATUS.md](PORTING_STATUS.md).

```text
src/          Server MCP, tools, domain, dan integrasi bridge
extension/    Source extension MCP Control Center
scripts/      Skrip pembanding dan pengujian
test/         Test otomatis
```

> **Batas kompatibilitas:** operasi yang memerlukan otomasi antarmuka native Windows (Win32/UIA) belum memiliki backend FFI pada port Node.js ini. Kemampuan lainnya bergantung pada tool yang dipanggil dan status bridge Packet Tracer.

## Lisensi

Proyek ini menggunakan lisensi [MIT](LICENSE). Extension dalam repositori ini merupakan bagian dari proyek; atribusi komponen pihak ketiga mengikuti pemberitahuan pada file lisensi.
