# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real credentials are ever used.
import os

os.environ.setdefault('PRESTASHOP_URL', 'https://demo.example.com')
os.environ.setdefault('PRESTASHOP_WS_KEY', 'WSKEYDUMMY')
os.environ.setdefault('DRY_RUN', 'true')
