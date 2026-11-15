"""Coordinate-specific WCS construction for native SPHEREx exposures."""
import re

from astropy.wcs import WCS


_SIP_KEY = re.compile(r"(?:A|B|AP|BP)_(?:ORDER|DMAX|[0-9]+_[0-9]+)$")


def spectral_wcs(hdus):
    """Build detector wavelength WCS without inheriting celestial SIP distortion.

    SIP belongs to the primary sky WCS, not alternate W (detector wavelength
    and bandwidth). Filter a copy before construction so Astropy never applies
    SIP or emits its inconsistent-CTYPE message. Original science headers and
    their celestial transforms remain untouched.
    """
    header = hdus["IMAGE"].header.copy()
    for keyword in list(header):
        if _SIP_KEY.fullmatch(keyword):
            del header[keyword]
    return WCS(header, fobj=hdus, key="W")
