"""Wait for PostgreSQL protocol availability without adding a client image."""
import os
import socket
import struct
import time
from urllib.parse import urlparse

url = urlparse(os.environ['DATABASE_URL'])
# PostgreSQL's SSLRequest packet has an explicit response even before login.
# It confirms that PostgreSQL is accepting protocol connections, not just TCP.
for attempt in range(90):
    try:
        with socket.create_connection((url.hostname, url.port or 5432), timeout=3) as connection:
            connection.sendall(struct.pack('!II', 8, 80877103))
            if connection.recv(1) in (b'S', b'N'):
                print('PostgreSQL is accepting connections')
                break
    except OSError:
        pass
    if attempt == 89:
        raise SystemExit('PostgreSQL did not become available')
    time.sleep(2)
