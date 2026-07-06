import math

def utm32n_to_latlon(easting, northing):
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    e = math.sqrt(e2)
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0
    
    x = easting - 500000.0
    y = northing
    
    # footprint latitude
    M = y / k0
    mu = M / (a * (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    
    foot_lat = (mu + (3.0*e1/2.0 - 27.0*e1**3/32.0)*math.sin(2.0*mu)
                + (21.0*e1**2/16.0 - 55.0*e1**4/32.0)*math.sin(4.0*mu)
                + (151.0*e1**3/96.0)*math.sin(6.0*mu)
                + (1097.0*e1**4/512.0)*math.sin(8.0*mu))
    
    sin_foot = math.sin(foot_lat)
    cos_foot = math.cos(foot_lat)
    tan_foot = math.tan(foot_lat)
    
    N1 = a / math.sqrt(1.0 - e2 * sin_foot**2)
    R1 = a * (1.0 - e2) / (1.0 - e2 * sin_foot**2)**1.5
    D_val = x / (N1 * k0)
    
    lat = (foot_lat - (N1 * tan_foot / R1) * (D_val**2/2.0 
           - (5.0 + 3.0*tan_foot**2 + 10.0*ep2*cos_foot**2 - 4.0*(ep2*cos_foot**2)**2 - 9.0*ep2)*D_val**4/24.0
           + (61.0 + 90.0*tan_foot**2 + 298.0*ep2*cos_foot**2 + 45.0*tan_foot**4 - 252.0*ep2 - 3.0*(ep2*cos_foot**2)**2)*D_val**6/720.0))
           
    lon = (lon0 + (D_val - (1.0 + 2.0*tan_foot**2 + ep2*cos_foot**2)*D_val**3/6.0
           + (5.0 - 2.0*ep2*cos_foot**2 + 28.0*tan_foot**2 - 3.0*(ep2*cos_foot**2)**2 + 8.0*ep2 + 24.0*tan_foot**4)*D_val**5/120.0) / cos_foot)
           
    return lat * 180.0 / math.pi, lon * 180.0 / math.pi

# Test with first row coordinate from image:
# x = 442972.981, y = 5937097.795
lat, lon = utm32n_to_latlon(442972.981, 5937097.795)
print(f"UTM: (442972.981, 5937097.795)")
print(f"Converted Lat/Lon: ({lat}, {lon})")
print(f"Expect near Wilhelmshaven (Latitude 53.5768 N, Longitude 8.1402 E)")
