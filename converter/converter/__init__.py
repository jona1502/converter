"""Privater Bild-/PDF-Konverter für den Go-Worker.

Bewusst ohne Importe: ``python -m converter.cli`` darf vor der Sandbox
keine nativen Parser (Pillow, pikepdf) laden.
"""
