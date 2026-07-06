import math

def latlon_to_utm32n(lat, lon):
    # WGS84 Ellipsoid constants
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0  # Central Meridian for Zone 32 (9 degrees East)
    
    lat_rad = lat * math.pi / 180.0
    lon_rad = lon * math.pi / 180.0
    
    N = a / math.sqrt(1.0 - e2 * math.sin(lat_rad)**2)
    T = math.tan(lat_rad)**2
    C = ep2 * math.cos(lat_rad)**2
    A = (lon_rad - lon0) * math.cos(lat_rad)
    
    # Meridian distance calculation
    M = a * (
        (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0) * lat_rad
        - (3.0*e2/8.0 + 3.0*e2**2/32.0 + 45.0*e2**3/1024.0) * math.sin(2.0*lat_rad)
        + (15.0*e2**2/256.0 + 45.0*e2**3/1024.0) * math.sin(4.0*lat_rad)
        - (35.0*e2**3/3072.0) * math.sin(6.0*lat_rad)
    )
    
    # Easting (x)
    x = k0 * N * (
        A + (1.0 - T + C) * A**3 / 6.0
        + (5.0 - 18.0*T + T**2 + 72.0*C - 58.0*ep2) * A**5 / 120.0
    ) + 500000.0
    
    # Northing (y)
    y = k0 * (
        M + N * math.tan(lat_rad) * (
            A**2 / 2.0
            + (5.0 - T + 9.0*C + 4.0*C**2) * A**4 / 24.0
            + (61.0 - 58.0*T + T**2 + 600.0*C - 330.0*ep2) * A**6 / 720.0
        )
    )
    
    return x, y

# Test coordinate from database: VM 161 (X: 442972.981, Y: 5937097.795)
# In database.py, this converts to Lat/Lon: (53.579631035752335, 8.138661207068754)
test_lat, test_lon = 53.579631035752335, 8.138661207068754
x, y = latlon_to_utm32n(test_lat, test_lon)

print(f"Original UTM: (442972.981, 5937097.795)")
print(f"Calculated UTM: ({x:.3f}, {y:.3f})")
print(f"Difference X: {x - 442972.981:.6f}")
print(f"Difference Y: {y - 5937097.795:.6f}")
