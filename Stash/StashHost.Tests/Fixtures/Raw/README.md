# RAW test fixture

## `blackmagic_micro_cinema_12bit.dng`

- **Source:** https://raw.pixls.us/getfile.php/7317/nice/Blackmagic%20-%20Micro%20Cinema%20Camera%20-%2012bit%20(16%3A9).dng
- **Camera:** Blackmagic Micro Cinema Camera
- **Mode:** 12-bit DNG (16:9)
- **License:** CC0 1.0 Universal (Public Domain Dedication)
  - https://creativecommons.org/publicdomain/zero/1.0/
- **SHA-256:** `4c65b8cda205087cfb94d8931811e53e15eb4df538ad67c1b4a3e76c1185b277`
- **Size:** 1,228,096 bytes
- **Dimensions:** 1952 x 1104

The fixture is used only by `Phase3BackendTests` to verify that the production
Magick.NET/RAW decoder path can convert a real camera DNG to JPEG. It is not
used by the application at runtime.
