from datetime import datetime

from shared_db import db

# Hotel architecture: the physical layout tickets and assets live in. A building has
# numbered floors, a floor has rooms. The human-readable IDs are derived, never stored, so
# renaming a building's code re-labels every floor and room under it in one step:
#   building  "A"          (Building.code, editable)
#   floor     "A_2"        (building code + floor number)
#   room      "A_2_204"    (floor ID + room number)
# BoardShape is the site-plan whiteboard: free shapes, optionally linked to a building.


class Building(db.Model):
    __tablename__ = 'hotel_buildings'

    id = db.Column(db.Integer, primary_key=True)
    # Short ID shown everywhere ("A", "MAIN", "B2"). Unique (enforced in routes.py) and never
    # contains "_", which separates the parts of floor/room IDs.
    code = db.Column(db.String(20), nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    floors = db.relationship('Floor', backref='building', order_by='Floor.number',
                             cascade='all, delete-orphan')


class Floor(db.Model):
    __tablename__ = 'hotel_floors'

    id = db.Column(db.Integer, primary_key=True)
    building_id = db.Column(db.Integer, db.ForeignKey('hotel_buildings.id', ondelete='CASCADE'),
                            nullable=False, index=True)
    number = db.Column(db.Integer, nullable=False)  # 1..N within the building
    name = db.Column(db.String(120))

    rooms = db.relationship('Room', backref='floor', order_by='Room.position',
                            cascade='all, delete-orphan')

    @property
    def code(self):
        return f'{self.building.code}_{self.number}'


class Room(db.Model):
    __tablename__ = 'hotel_rooms'

    id = db.Column(db.Integer, primary_key=True)
    floor_id = db.Column(db.Integer, db.ForeignKey('hotel_floors.id', ondelete='CASCADE'),
                         nullable=False, index=True)
    # Door number as printed ("204", "2-A"); unique within its floor. Defaults to
    # floor number + two-digit index (201, 202, ...), editable afterwards.
    number = db.Column(db.String(20), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)  # order on the floor

    @property
    def code(self):
        return f'{self.floor.code}_{self.number}'


class BoardShape(db.Model):
    """One shape on the site-plan whiteboard, in board units (the board is 1600 x 1000).
    Linked to a building, it shows "name / ID" and opens that building; unlinked, it's a
    plain labelled shape (pool, parking, gate...)."""
    __tablename__ = 'hotel_board_shapes'

    id = db.Column(db.Integer, primary_key=True)
    building_id = db.Column(db.Integer, db.ForeignKey('hotel_buildings.id', ondelete='SET NULL'),
                            index=True)
    kind = db.Column(db.String(20), nullable=False, default='rect')
    x = db.Column(db.Float, nullable=False, default=100)
    y = db.Column(db.Float, nullable=False, default=100)
    w = db.Column(db.Float, nullable=False, default=200)
    h = db.Column(db.Float, nullable=False, default=120)
    fill = db.Column(db.String(9), nullable=False, default='#ede9fe')
    text = db.Column(db.String(200))
    z = db.Column(db.Integer, nullable=False, default=0)

    building = db.relationship('Building')
