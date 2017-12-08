"use strict";

// Helper functions.
function is_numeric(...values) {
	return values.every(x => typeof x === "number");
}

function clamp(min, value, max) {
	return Math.min(max, Math.max(min, value));
}

function call_if_defined(context, ...fns) {
	for (const fn of fns) {
		if (typeof fn === "function") {
			fn.call(context);
			break;
		}
	}
}

// Global constants.
const [WIDTH, HEIGHT] = [768, 608];
const PD = window.devicePixelRatio; // Pixel density.
const TAU = 2 * Math.PI;
const SECS = 1000;
const FRAME_RATE = 60;
const PLAYER_SPEED = 4;
const MAX_ENEMIES = 30;
const AUTOMATIC_FIRING = false;
const FIRING_RATE = 0.1;

// Grid constants.
const CELL_SIZE = 32; // The size of each grid cell.
const BOUNDARY = 1; // How many extra cells to draw offscreen (to ensure the player doesn't see the edge of the grid).

// Set up the canvas for drawing.
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");
// We need to make sure the pixel density matches the screen, so it doesn't look blurry on 2x devices.
canvas.width = WIDTH * PD;
canvas.height = HEIGHT * PD;
canvas.style.width = `${WIDTH}px`;
canvas.style.height = `${HEIGHT}px`;

// Keyboard control.
const keys = {
	name (key) {
		if (key >= 65 && key <= 90) // Letters.
			return String.fromCharCode(key);
		return "(" + key + ")";
	},
	held : new Map(),
	is_pressed(key) {
		return this.held.get(key) === 1;
	},
	is_held(key) {
		return this.held.has(key);
	},
	press(key) {
		if (!this.held.has(key))
			this.held.set(key, 1);
	},
	release(key) {
		this.held.delete(key);
	}
};
window.addEventListener("keydown", (event) => {
	keys.press(keys.name(event.keyCode));
	 if (!(event.metaKey || event.ctrlKey))
	 	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	keys.release(keys.name(event.keyCode));
	 if (!(event.metaKey || event.ctrlKey))
	 	event.preventDefault();
});

// Mouse control.
const cursor = {
	x: WIDTH / 2,
	y: HEIGHT / 2,
	held: 0,
	move({x, y}) {
		[this.x, this.y] = [x, y];
	},
	is_pressed() {
		return this.held === 1;
	},
	is_held() {
		return this.held !== 0;
	},
	press() {
		this.held = 1;
	},
	release() {
		this.held = 0;
	},
	position_from_event(event) {
		const rect = canvas.getBoundingClientRect();
		return {x: event.pageX - window.scrollX - rect.left, y: event.pageY - window.scrollY - rect.top};
	}
};
canvas.addEventListener("mousemove", (event) => cursor.move(cursor.position_from_event(event)));
canvas.addEventListener("mousedown", (event) => {
	if (event.button !== 0)
		return;
	cursor.move(cursor.position_from_event(event));
	cursor.press();
});
canvas.addEventListener("mouseup", (event) => {
	if (event.button !== 0)
		return;
	cursor.move(cursor.position_from_event(event));
	cursor.release();
});

window.addEventListener("DOMContentLoaded", () => {
	document.body.appendChild(canvas);
	// Press F for full-screen mode.
	window.addEventListener("keydown", (event) => {
		if (event.keyCode === 70) {
			if (document.fullscreen || document.webkitIsFullScreen || document.mozFullScreen)
				call_if_defined(document, document.exitFullscreen, document.webkitExitFullscreen, document.mozCancelFullScreen);
			else call_if_defined(document.documentElement, document.documentElement.requestFullscreen, document.documentElement.webkitRequestFullscreen, document.documentElement.mozRequestFullScreen);
			event.stopPropagation();
		}
	});
});

let game;

document.addEventListener("visibilitychange", () => {
	if (document.hidden)
		game.pause();
});

// Functions for drawing.
const draw = {
	TEXT_CENTRED: {h: "center", v: "middle"},
	with_glow(fn, colour, blur = 16) {
		context.shadowColor = colour;
		context.shadowBlur = blur * PD;
		fn();
		context.shadowBlur = 0;
	},
	with_alpha(fn, alpha) {
		context.globalAlpha = alpha;
		fn();
		context.globalAlpha = 1;
	},
	isosceles_triangle(o, radius, side_scale) {
		context.beginPath();
		context.moveTo((o.x + Math.cos(o.dir) * radius) * PD, (o.y + Math.sin(o.dir) * radius) * PD);
		context.lineTo((o.x + Math.cos(o.dir + TAU / 3) * radius / side_scale) * PD, (o.y + Math.sin(o.dir + TAU / 3) * radius / side_scale) * PD);
		context.lineTo((o.x + Math.cos(o.dir - TAU / 3) * radius / side_scale) * PD, (o.y + Math.sin(o.dir - TAU / 3) * radius / side_scale) * PD);
		context.closePath();
	},
	polygon(o, radius, sides) {
		context.beginPath();
		for (let i = 0; i < sides; ++i)
			context.lineTo((o.x + Math.cos(i / sides * TAU + o.rotate) * radius) * PD, (o.y + Math.sin(i / sides * TAU + o.rotate) * radius) * PD);
		context.closePath();
		draw.with_glow(() => context.stroke(), context.strokeStyle);
	},
	text(o, text, size, align = {h: "left", v: "top"}, font = `CamingoCode, Helvetica, sans-serif`) {
		context.textAlign = align.h;
		context.textBaseline = align.v;
		const font_and_size = `${size * PD}px ${font}`;
		context.font = font_and_size;
		context.fillText(text, o.x * PD, o.y * PD);
	},
};

class Game {
	constructor() {
		this.entities = [];
		this.enemies = [];
		this.player = null;
		this.at_title_screen = true; // Whether to display the initial title screen.
		this.start_time = 0;
		this.is_over = 0; // Values from 0 to 1 to transition in the "GAME OVER" screen.
		this.is_paused = false;
		this.score = 0;
		this.score_drawn = 0; // We have a separate variable for the drawn score to animate it.
		this.difficulty = 0; // Corresponds to the sides of the shapes.
		this.difficulty_interval = null; // An interval increasing the difficulty every so often.
		this.powerups = new Set();
		this.firing_timeout = 0; // There's a limit on how frequently the player may fire.
		this.automatic_firing_interval = null;
		this.screen_shakes = [];
	}
	initialise() {
		this.player = new Player({x: WIDTH / 2, y: HEIGHT / 2 - 60, dir: TAU / 4});
	}
	// Start the gameplay (following the title screen).
	begin() {
		this.at_title_screen = false;
		this.start_time = Date.now();
		this.next_spawn_time = Date.now();
		this.difficulty_interval = setInterval(() => ++this.difficulty, 30 * SECS);
		if (AUTOMATIC_FIRING)
			this.automatic_firing_interval = setInterval(this.player.shoot, FIRING_RATE * SECS);
	}
	// Each time step, perform actions.
	update() {
		if (cursor.y !== game.player.y || cursor.x !== game.player.x)
			game.player.dir = Math.atan2(cursor.y - game.player.y, cursor.x - game.player.x);
		// Clicking.
		if (!this.paused && cursor.is_pressed()) {
			if (this.at_title_screen)
				this.begin();
			if (!this.is_over) {
				if (!AUTOMATIC_FIRING && Date.now() - this.firing_timeout > FIRING_RATE * SECS) {
					this.player.shoot();
					this.firing_timeout = Date.now();
				}
			} else if (this.is_over >= 1)
				this.restart();
		}
		// Pausing / unpausing.
		if (this.is_paused) {
			if (cursor.is_pressed() || keys.is_pressed("P"))
				this.is_paused = false;
		} else if (keys.is_pressed("P"))
			this.pause();
		if (!this.is_paused) {
			// Spawn enemies and powerups.
			const now = Date.now();
			if (!this.at_title_screen && !this.is_over && now >= this.next_spawn_time) {
				this.spawn_enemy();
				this.spawn_powerup();
				this.next_spawn_time = now + Math.max(200, 5000 * Math.pow(1.02, -(now - this.start_time) / 1000));
			}
			// Update all the objects in the game.
			for (let i = 0; i < this.entities.length; ++i) {
				const o = this.entities[i];
				i -= o.update(i) || 0; // The object deleted itself or other entities in its updater method.
				o.clean();
			}
			// Update the grid distortion effect.
			grid.update();
			// Draw everything.
			this.draw();
		}
		// Keep track of how long keys / the mouse has been held.
		for (const [key, value] of keys.held.entries())
			keys.held.set(key, value + 1);
		if (cursor.held)
			++cursor.held;
	}
	// Draw everything.
	draw() {
		// Draw the background
		context.fillStyle = "black";
		context.fillRect(0, 0, WIDTH * PD, HEIGHT * PD);
		// Pick the screen shake offset with the maximum magnitude.
		let screen_shake = {x: 0, y: 0, mag: 0};
		for (const screen_shake of this.screen_shakes) {
			if (screen_shake.mag > screen_shake.mag)
				screen_shake = screen_shake;
		}
		context.translate(screen_shake.x, screen_shake.y); // Translate everything we draw to simulate a screen shake.
		grid.draw();
		// Draw the entities
		for (const o of game.entities)
			o.draw();
		context.translate(-screen_shake.x, -screen_shake.y); // We don't want the HUD to be translated.
		this.screen_shakes = []; // The screen shake will be updated each time step, so we clear it here to make sure shakes aren't persistent.
		// Draw the HUD
		context.fillStyle = "white";
		if (game.score_drawn < game.score)
			game.score_drawn = Math.min(game.score, game.score_drawn + 100);
		if (!game.at_title_screen)
			draw.with_glow(() => draw.text({x: 12, y: 12}, `SCORE: ${game.score_drawn}`, 24), context.fillStyle);
		// Game over screen
		if (game.at_title_screen) {
			draw.with_glow(() => draw.text({x: WIDTH / 2, y: HEIGHT / 2}, "DISTORT", 80, draw.TEXT_CENTRED), context.fillStyle);
			draw.with_glow(() => draw.text({x: WIDTH / 2, y: HEIGHT / 2 + 80}, "WASD + MOUSE", 20, draw.TEXT_CENTRED), context.fillStyle, 2);
		} else if (game.is_over) {
			draw.with_alpha(() => draw.with_glow(() => draw.text({x: WIDTH / 2, y: HEIGHT / 2 - 60 * (1 - game.is_over)}, "GAME OVER", 64, draw.TEXT_CENTRED), context.fillStyle), game.is_over);
			game.is_over = Math.min(1, game.is_over + 0.01);
		}
		// Pause screen.
		if (game.is_paused) {
			context.fillStyle = "black";
			draw.with_alpha(() => context.fillRect(0, 0, WIDTH * PD, HEIGHT * PD), 0.5);
			context.fillStyle = "white";
			draw.with_glow(() => draw.text({x: WIDTH / 2, y: HEIGHT / 2}, "PAUSED", 80, draw.TEXT_CENTRED), context.fillStyle);
			draw.with_glow(() => draw.text({x: WIDTH / 2, y: HEIGHT / 2 + 80}, "CLICK / PRESS P TO RESUME", 20, draw.TEXT_CENTRED), context.fillStyle, 2);
		}
	}
	pause() {
		if (!this.at_title_screen && !this.is_over) {
			this.is_paused = true;
			game.draw();
		}
	}
	// Make sure Game cleans up after itself.
	end() {
		clearInterval(this.difficulty_interval);
		clearInterval(this.automatic_firing_interval);
	}
	restart() {
		this.end();
		game = new Game();
		game.initialise();
	}
	spawn_enemy() {
		// Without a limit, the game just becomes uplayable.
		if (this.enemies.length > MAX_ENEMIES)
			return;
		let x, y;
		// Pick a random side from which to approach.
		switch (Math.floor(Math.random() * 4)) {
			case 0: [x, y] = [-CELL_SIZE, Math.random() * (HEIGHT + CELL_SIZE * 2) - CELL_SIZE];			break;
			case 1: [x, y] = [WIDTH + CELL_SIZE, y = Math.random() * (HEIGHT + CELL_SIZE * 2) - CELL_SIZE];	break;
			case 2: [y, x] = [-CELL_SIZE, x = Math.random() * (WIDTH + CELL_SIZE * 2) - CELL_SIZE];			break;
			case 3: [y, x] = [HEIGHT + CELL_SIZE, x = Math.random() * (WIDTH + CELL_SIZE * 2) - CELL_SIZE];	break;
		}
		new Enemy({x, y, difficulty: this.difficulty});
	}
	spawn_powerup() {
		// There's some progression of powerups, though this doesn't completely preclude the possibility two duplicate powerups spawn if the player isn't fast enough.
		if (!this.powerups.has("quad") && Math.random() < 1/(6 + this.powerups.has("double") ? 2 : 0 + this.powerups.has("triple") ? 4 : 0) && this.difficulty >= 2) {
			new Powerup({x: WIDTH / 4 + Math.random() * WIDTH / 2, y: HEIGHT / 4 + Math.random() * HEIGHT / 2, powerup: this.powerups.has("double") ? (this.powerups.has("triple") ? "quad" : "triple") : "double"});
		}
	}
	trigger_particle_effect(pos, size, deflect, parts) {
		for (let j = 0; j < parts; ++j) {
			const size_with_variance = size + Math.random() * 1;
			new Particle({x: pos.x, y: pos.y, dir: pos.dir + TAU / 2 - deflect / 2 + deflect * Math.random(), spd: 0.5 + Math.random() * 2, size: size_with_variance, dist: size_with_variance});
		}
	}
	shake_screen(max_mag, time) {
		const start = Date.now();
		const end = Date.now() + time;
		const interval = setInterval(() => {
			const dir = Math.random() * TAU;
			const mag = max_mag * (1 - (Date.now() - start) / (end - start));
			const screen_shake = {x: Math.cos(dir) * mag, y: Math.sin(dir) * mag, mag};
			this.screen_shakes.push(screen_shake);
		}, 1000 / 60);
		setTimeout(() => clearInterval(interval), time);
	}
}
game = new Game(); // Initialise the game state immediately.

class Drawable {
	update() {}
	draw() {}
}

// Entities (i.e. game objects).
class Entity extends Drawable {
	constructor({x, y, dir = 0, spd = 0, dist = 0, fade = false, alpha = 1, destroy = 1/8}, add_to_world = true) {
		super();
		this.x = x;
		this.y = y;
		this.dir = dir;
		this.spd = spd;
		this.dist = dist; // How much objects distort the grid.
		this.fade = fade; // Whether objects should be deleted after a time (specifically: when they are no longer distorting the grid).
		this.alpha = alpha; // The alpha of entities. If this reaches 0, the entity is destroyed.
		this.destroy = destroy; // How quickly to destroy the object.
		console.assert(is_numeric(this.x, this.y, this.dir, this.spd, this.dist), "An entity was created with invalid properties: %o", this); // This catches a lot of silly mistakes due to JavaScript's weak typing model.
		if (add_to_world)
			game.entities.push(this);
	}
	update(i) {
		let deleted = super.update(i);
		// Move the entity.
		this.x += Math.cos(this.dir) * this.spd;
		this.y += Math.sin(this.dir) * this.spd;
		const size = Math.max(0, this.dist);
		const offscreen = this.x + size < 0 || this.x - size >= WIDTH || this.y + size < 0 || this.y - size >= HEIGHT;
		if (this.fade || (offscreen && (this instanceof Powerup)))
			this.dist -= this.destroy * (offscreen ? 4 : 1);
		// Remove objects if they no longer distort the grid, or if they are completely transparent.
		if ((this.fade && this.dist <= 0) || this.alpha <= 0) {
			game.entities.splice(i, 1);
			++deleted;
		}
		return deleted;
	}
	clean() {
		this.dist = Math.max(0, this.dist);
	}
}

class Grid extends Drawable {
	constructor() {
		super();
		this.grid = [];
		// Fill the grid with points.
		for (let y = -BOUNDARY * CELL_SIZE; y <= HEIGHT + BOUNDARY * CELL_SIZE; y += CELL_SIZE) {
			for (let x = -BOUNDARY * CELL_SIZE; x <= WIDTH + BOUNDARY * CELL_SIZE; x += CELL_SIZE) {
				this.grid.push({x, y, o: {x, y}});
			}
		}
	}
	update(i) {
		let deleted = super.update(i);
		const max_dist = CELL_SIZE * BOUNDARY * 4;
		// The grid distortion effect.
		for (const p of this.grid) {
			let delta = {x: 0, y: 0};
			for (const o of game.entities) {
				if (o.dist) {
					const dir = Math.atan2(p.o.y - o.y, p.o.x - o.x);
					let dis = o.dist / Math.pow(1.5, Math.hypot(p.o.y - o.y, p.o.x - o.x) / CELL_SIZE);
					dis = Math.min(dis, max_dist);
					if (o.invert)
						dis = -dis;
					delta.x += Math.cos(dir) * dis;
					delta.y += Math.sin(dir) * dis;
				}
			}
			p.x = p.o.x + delta.x;
			p.y = p.o.y + delta.y;
		}
		return deleted;
	}
	draw() {
		const gradient = context.createRadialGradient(game.player.x * PD, game.player.y * PD, 0, game.player.x * PD, game.player.y * PD, Math.hypot(WIDTH, HEIGHT) * PD);
		gradient.addColorStop(0, "red");
		gradient.addColorStop(1, "blue");
		context.fillStyle = context.strokeStyle = gradient;
		for (const p of this.grid) {
			context.fillRect((p.x - 2) * PD, (p.y - 2) * PD, 4 * PD, 4 * PD);
		}
		context.lineWidth = 1;
		// Draw the rows
		for (let y = 0; y <= (HEIGHT / CELL_SIZE + BOUNDARY * 2); ++y) {
			context.beginPath();
			for (let x = 0; x <= (WIDTH / CELL_SIZE + BOUNDARY * 2); ++x) {
				const p = this.grid[y * (WIDTH / CELL_SIZE + BOUNDARY * 2 + 1) + x];
				context.lineTo(p.x * PD, p.y * PD);
			}
			context.stroke();
		}
		// Draw the columns
		for (let x = 0; x <= (WIDTH / CELL_SIZE + BOUNDARY * 2); ++x) {
			context.beginPath();
			for (let y = 0; y <= (HEIGHT / CELL_SIZE + BOUNDARY * 2); ++y) {
				const p = this.grid[y * (WIDTH / CELL_SIZE + BOUNDARY * 2 + 1) + x];
				context.lineTo(p.x * PD, p.y * PD);
			}
			context.stroke();
		}
	}
}
const grid = new Grid;

class Collidable extends Entity {
	constructor({x, y, ...override}, add_to_world) {
		super({x, y}, add_to_world);
		Object.assign(this, override);
	}
	update(i) {
		let deleted = super.update(i);
		for (const e of game.enemies) {
			if (Math.hypot(e.x - this.x, e.y - this.y) < 32) { // Collision code (we can treat polygons as essentially circles).
				if (!(e instanceof Powerup)) {
					// If the object hits an enemy (that's not a powerup), destroy the object.
					game.entities.splice(game.entities.indexOf(this), 1);
					++deleted;
				} else if (this instanceof Player)
					game.powerups.add(e.powerup); // If the player hits a powerup, they pick it up.
				if (this instanceof Player) {
					if (!(e instanceof Powerup)) {
						// Shake the screen if the player hits an enemy.
						game.shake_screen(50, 1.5 * 1000);
						game.is_over += 0.01;
					}
				} else game.shake_screen(10, 0.2 * 1000); // If a collision occurs, shake the screen a little.
				const deflect = TAU / 8;
				const size = this instanceof Player ? 4 : 2;
				const parts = (this instanceof Player ? 16 : 8) + Math.floor(Math.random() * 16);
				if (!(e instanceof Powerup))
					game.trigger_particle_effect(this, size, deflect, parts);
				e.recoil = 1; // Make the enemy animate when hit.
				--e.hp;
				// Push the enemy back when hit.
				const thrust = 20;
				const direct_dir = Math.atan2(e.y - game.player.y, e.x - game.player.x);
				e.x += Math.cos(direct_dir) * thrust;
				e.y += Math.sin(direct_dir) * thrust;
				if (e.hp === 0) {
					if (this instanceof Player || !(e instanceof Powerup)) {
						// Award points if the player hits a powerup, or if an enemy is destroyed.
						game.score += e.points;
						new ScoreDelta({x: e.x, y: e.y, points: e.points});
					}
					// Destroy the enemy.
					const index = game.entities.indexOf(e);
					game.entities.splice(index, 1);
					game.enemies.splice(game.enemies.indexOf(e), 1);
					if (index <= i)
						++deleted;
					if (!(e instanceof Powerup)) // We don't shake the screen when powerups are hit.
						game.shake_screen(100, 0.4 * 1000);
					new Displacement({x: e.x, y: e.y, dist: (e.difficulty + 1) * 25, invert: e instanceof Powerup ? true : false, destroy: 4}); // When an enemy is hit, create an explosion (or imposion, in the case of the powerup) effect.
					game.trigger_particle_effect(e, 4, TAU, 8 + Math.floor(Math.random() * 16));
				}
				break;
			}
		}
		return deleted;
	}
}

class Player extends Collidable {
	constructor({x, y, dir, ...override}, add_to_world) {
		super({x, y, dir}, add_to_world);
		Object.assign(this, override);
	}
	update(i) {
		let deleted = super.update(i);
		const prev = {x: this.x, y: this.y};
		// Move the player with WASD.
		if (keys.is_held("W"))
			this.y -= PLAYER_SPEED;
		if (keys.is_held("S"))
			this.y += PLAYER_SPEED;
		if (keys.is_held("A"))
			this.x -= PLAYER_SPEED;
		if (keys.is_held("D"))
			this.x += PLAYER_SPEED;
		[this.x, this.y] = [clamp(0, this.x, WIDTH), clamp(0, this.y, HEIGHT)];
		// Distort the grid as the player moves.
		if (Math.abs(this.x - prev.x) !== 0 || Math.abs(this.y - prev.y) !== 0)
			this.dist = Math.min(this.dist + 0.5, PLAYER_SPEED * 2);
		return deleted;
	}
	draw() {
		context.strokeStyle = "white";
		context.lineWidth = 4;
		draw.isosceles_triangle(this, 16, 1.5);
		draw.with_glow(() => context.stroke(), context.strokeStyle);
	}
	shoot() {
		if (!game.at_title_screen && !game.is_over) {
			const bullets = game.powerups.has("quad") ? 4 : game.powerups.has("triple") ? 3 : game.powerups.has("double") ? 2 : 1;
			const spread = TAU / 16;
			for (let b = 0; b < bullets; ++b)
				new Bullet({x: this.x, y: this.y, dir: this.dir + (bullets > 1 ? b / (bullets - 1) * spread - spread / 2 : 0), spd: 10, dist: 16});
		}
	}
}

class Bullet extends Collidable {
	constructor({x, y, dir, spd, dist, ...override}, add_to_world) {
		super({x, y, dir, spd, dist: dist / 8, fade: true}, add_to_world);
		this.dist_max = dist;
		Object.assign(this, override);
	}
	update(i) {
		let deleted = super.update(i);
		// We fade in the distortion for bullets, so the grid doesn't jump.
		if (this.dist < this.dist_max) {
			this.dist = Math.min(this.dist_max, this.dist + 2);
			if (this.dist === this.dist_max)
				this.dist_max = 0;
		}
		return deleted;
	}
	draw() {
		context.strokeStyle = "white";
		context.lineWidth = 4;
		draw.isosceles_triangle(this, 8, 1.5);
		draw.with_glow(() => context.stroke(), context.strokeStyle);
	}
}

class Enemy extends Entity {
	constructor({x, y, difficulty, ...override}, add_to_world = true) {
		super({x, y, dir: Math.atan2(game.player.y - y, game.player.x - x), spd: (difficulty + 3) / 3}, add_to_world);
		this.difficulty = difficulty;
		this.recoil = 0;
		this.hp = Math.ceil(Math.pow(difficulty + 3, 1.5));
		this.rotate = Math.random() * TAU * (Math.random() > 0.5 ? 1 : -1);
		this.points = 1000;
		Object.assign(this, override);
		if (add_to_world)
			game.enemies.push(this);
	}
	update(i) {
		let deleted = super.update(i);
		this.recoil = Math.max(this.recoil - 0.05, 0); // Decrease the recoil over time, so the effect is short-lived.
		// We fade in the distortion for bullets, so the grid doesn't jump.
		if (this.dist < (this.difficulty + 3) * 4)
			this.dist = Math.min((this.difficulty + 3) * 4, this.dist + 0.5);
		if (game.is_over)
			this.spd = 0;
		this.dir = Math.atan2(game.player.y - this.y, game.player.x - this.x); // Always move towards the player.
		return deleted;
	}
	draw() {
		const radius = 32 - this.recoil * 8;
		const sides = this.difficulty + 3;
		context.strokeStyle = `hsl(0, 100%, ${(1 - this.recoil / 2) * 100}%)`; // Flash red when hit.
		context.lineWidth = 4;
		draw.polygon(this, radius, sides);
		draw.with_glow(() => context.stroke(), context.strokeStyle);
		this.rotate += TAU / 60 / 8 * (Math.sign(this.rotate) || 1);
	}
}

class Powerup extends Entity {
	constructor({x, y, powerup, ...override}, add_to_world = true) {
		super({x, y, dir: Math.random() * TAU, spd: 0.5, hp: 1, points: 2500, difficulty: 3}, add_to_world);
		this.alpha = 0.1;
		this.powerup = powerup;
		Object.assign(this, override);
		if (add_to_world)
			game.enemies.push(this);
	}
	draw() {
		const size = 8;
		context.strokeStyle = "white";
		context.shadowColor = context.strokeStyle;
		const points = 8;
		const dis = 10;
		const inner_size = 12;
		const offset = Date.now() / 1000 * TAU / 4;
		// Double circle.
		draw.with_alpha(() => draw.with_glow(() => {
			context.beginPath();
			context.lineWidth = 3;
			context.arc(this.x * PD, this.y * PD, inner_size * PD, 0, TAU);
			context.stroke();
			context.beginPath();
			context.arc(this.x * PD, this.y * PD, size * PD, 0, TAU);
			context.stroke();
			context.lineWidth = 1;
			context.globalAlpha = 1;
		}), this.alpha);
		this.alpha = Math.min(1, this.alpha + 0.05); // Fade the powerup in, so it looks natural.
	}
}

class Particle extends Entity {
	constructor({x, y, dir, dist, size, ...override}, add_to_world) {
		super({x, y, dir, dist, fade: true}, add_to_world);
		this.size = size;
		Object.assign(this, override);
	}
	draw() {
		const size = this.dist * this.size;
		context.fillStyle = "white";
		draw.with_glow(() => context.fillRect((this.x - size) * PD, (this.y - size) * PD, size * PD, size * PD), context.fillStyle);
	}
}

class ScoreDelta extends Entity {
	constructor({x, y, points, ...override}, add_to_world) {
		super({x, y, spd: 4, dir: -TAU / 4});
		this.points = points;
		Object.assign(this, override);
	}
	draw() {
		context.fillStyle = "white";
		context.globalAlpha = this.alpha;
		this.alpha -= 0.025;
		draw.with_glow(() => draw.text(this, `+${this.points}`, 18, draw.TEXT_CENTRED), context.fillStyle);
		context.globalAlpha = 1;
	}
}

class Displacement extends Entity {
	constructor({x, y, dist, invert, destroy, ...override}, add_to_world) {
		super({x, y, dist, invert, destroy, fade: true});
		Object.assign(this, override);
	}
}

game.initialise(); // Set up the game ready to begin.
setInterval(() => game.update(), SECS / FRAME_RATE); // The game loop.