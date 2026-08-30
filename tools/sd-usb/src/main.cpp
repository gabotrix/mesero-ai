// Diagnostico de la microSD de la XIAO Expansion Board.
//
// Responde una sola pregunta: la tarjeta esta viva o no. El lector del PC dice
// "No Media" sin mas detalle, asi que hace falta preguntarselo a otro hardware.
//
// Repite el intento en bucle y por el puerto serie, a proposito: la version
// anterior salia de setup() al fallar el montaje y se quedaba muda justo en el
// caso que interesaba diagnosticar.

#include <Arduino.h>
#include <SPI.h>
#include <SD.h>

// La expansion board cuelga la ranura del SPI del XIAO (SCK=D8, MISO=D9,
// MOSI=D10). El chip select cambia entre revisiones, asi que se prueban varios.
static const int CS_CANDIDATOS[] = {D2, D1, D3, D0, D7, D6};
static const char *NOMBRES[] = {"D2", "D1", "D3", "D0", "D7", "D6"};
static const unsigned N_CS = sizeof(CS_CANDIDATOS) / sizeof(CS_CANDIDATOS[0]);

static void listarRaiz() {
    File raiz = SD.open("/");
    if (!raiz) {
        Serial.println("  no se pudo abrir la raiz");
        return;
    }
    int n = 0;
    for (File f = raiz.openNextFile(); f; f = raiz.openNextFile()) {
        Serial.printf("  %-34s %10u bytes%s\n", f.name(), (unsigned)f.size(),
                      f.isDirectory() ? "  <dir>" : "");
        f.close();
        n++;
    }
    raiz.close();
    if (n == 0) Serial.println("  (raiz vacia)");
}

static bool intentar() {
    SPI.end();
    SPI.begin(D8, D9, D10, D2);

    for (unsigned i = 0; i < N_CS; i++) {
        // Primero despacio: si la tarjeta esta al limite, 20 MHz la tumba y
        // 400 kHz la monta, y esa diferencia ya es un diagnostico.
        for (uint32_t hz : {400000u, 4000000u, 20000000u}) {
            if (SD.begin(CS_CANDIDATOS[i], SPI, hz)) {
                uint64_t sectores = SD.numSectors();
                Serial.println();
                Serial.printf("MONTADA en CS=%s a %u Hz\n", NOMBRES[i], (unsigned)hz);
                Serial.printf("  tipo      : %d\n", (int)SD.cardType());
                Serial.printf("  sector    : %u bytes\n", (unsigned)SD.sectorSize());
                Serial.printf("  sectores  : %llu\n", sectores);
                Serial.printf("  capacidad : %.2f GB\n",
                              sectores * (double)SD.sectorSize() / 1073741824.0);
                Serial.printf("  usado     : %llu de %llu bytes\n",
                              SD.usedBytes(), SD.totalBytes());
                Serial.println("  contenido:");
                listarRaiz();
                return true;
            }
            SD.end();
            delay(20);
        }
        Serial.printf("  CS=%-3s sin respuesta\n", NOMBRES[i]);
    }
    return false;
}

void setup() {
    Serial.begin(115200);
    delay(1500);              // margen para que el CDC enumere en el PC
    Serial.println();
    Serial.println("=== Diagnostico microSD — XIAO Expansion Board ===");
}

void loop() {
    Serial.println();
    Serial.println("--- intento ---");

    if (intentar()) {
        Serial.println();
        Serial.println("RESULTADO: la tarjeta responde. No esta muerta.");
    } else {
        Serial.println();
        Serial.println("RESULTADO: ningun pin ni velocidad la monta.");
        Serial.println("O no hay tarjeta en la ranura, o no hace contacto, o esta muerta.");
    }

    delay(5000);
}
