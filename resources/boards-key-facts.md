# Key facts about Miro boards and coordinates

## Board Coordinates

- Boards are infinite and zoomable in all directions
- The board center is at coordinates (0,0)
- All board-level coordinates are relative to this center point
- Board items use x,y coordinates to specify their position
- Item coordinates mark the CENTER point of the item

## Coordinate Types

- Board-level: Items directly on board use coordinates relative to board center (0,0)
- Parent-child: Child items inside parent containers (like frames) use coordinates relative to parent's top-left corner

## Units

- Measurements use board units
- 100 board units = 100 device-independent pixels at 100% zoom

## Default Behavior

 -Items created without specified coordinates default to board center (0,0)
 -Frames always appear behind other board items in the z-order
 -The initial viewport center when creating a new board becomes the board's (0,0) reference point
