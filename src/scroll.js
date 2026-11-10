import {computeFling, splinePosition, splineVelocity, VelocityTracker} from "./spline.js"

/// Touch slop in CSS px (ViewConfiguration's 8dp).
const TOUCH_SLOP = 8
/// Minimum and maximum fling velocity (ViewConfiguration, dp/s).
const MIN_FLING = 50
const MAX_FLING = 8000
/// Repeated flicks add up, like Android's list views (the scroller's
/// flywheel) and Chrome's own touch scrolling (FlingBooster).
const FLYWHEEL_CHECK = 40
/// Both the fling and the new flick must be this fast (CSS px/s) to add
/// up (Chrome's kMinBoostFlingSpeed).
const MIN_BOOST = 350
/// Accumulated flings are capped at this multiple of MAX_FLING.
const MAX_BOOST = 3

/**
 * @typedef {Object} Axis
 * @property {number} start
 * @property {number} distance
 * @property {number} duration
 */

/**
 * @typedef {Object} ScrollHost
 * @property {HTMLCanvasElement} surface
 * @property {number} dpr
 * @property {number} maxScrollTop
 * @property {number} maxScrollLeft
 * @property {number} scrollSpeed
 * @property {() => void} requestFrame
 * @property {(time: number) => void} noteInput
 */

/**
 * @param {Axis} f
 * @param {number} t
 * @returns {number}
 */
function axisPos(f, t) {
	return f.start + f.distance * splinePosition(t / f.duration)
}

/**
 * Velocity in px/s `t` ms into the fling (OverScroller's getCurrVelocity).
 * @param {Axis} f
 * @param {number} t
 * @returns {number}
 */
function axisVelocity(f, t) {
	return f.distance / f.duration * 1000 * splineVelocity(t / f.duration)
}

/**
 * Owns scrolling: the view never uses native overflow scrolling,
 * so the content is always drawn for the exact position shown and a
 * fling can't outrun rendering. Every frame on screen is fully drawn:
 * no blank areas during fast flings, even on slow Android WebViews.
 */
export class ScrollController {
	/**
	 * @param {ScrollHost} host
	 */
	constructor(host) {
		/** @type {ScrollHost} */
		this.host = host
		/** @type {number} */
		this.scrollTop = 0
		/** @type {number} */
		this.scrollLeft = 0
		/** @type {number} */
		this.pointerId = -1
		/** @type {number} */
		this.startX = 0
		/** @type {number} */
		this.startY = 0
		/** @type {number} */
		this.lastX = 0
		/** @type {number} */
		this.lastY = 0
		/** @type {boolean} */
		this.dragging = false
		/** @type {boolean} */
		this.lockX = false
		/** @type {boolean} */
		this.lockY = false
		/** @type {boolean} */
		this.stoppedFling = false
		/** @type {VelocityTracker} */
		this.vx = new VelocityTracker()
		/** @type {VelocityTracker} */
		this.vy = new VelocityTracker()
		/** @type {number} */
		this.flingStart = 0
		/** @type {number} */
		this.stepTime = 0
		/** @type {Axis|null} */
		this.flingY = null
		/** @type {Axis|null} */
		this.flingX = null
		/** @type {boolean} */
		this.flywheel = false
		/** @type {ReturnType<typeof setTimeout>|null} */
		this.flywheelTimer = null
		/** @type {number} */
		this.accumulatedY = 0
		/** @type {number} */
		this.accumulatedX = 0
		/** @type {ReturnType<typeof setTimeout>|null} */
		this.wheelTimer = null

		/** @type {(e: PointerEvent) => void} */
		this.onDown = (e) => this.pointerDown(e)
		/** @type {(e: PointerEvent) => void} */
		this.onMove = (e) => this.pointerMove(e)
		/** @type {(e: PointerEvent) => void} */
		this.onUp = (e) => this.pointerUp(e)
		/** @type {(e: PointerEvent) => void} */
		this.onCancel = (e) => this.pointerCancel(e)
		/** @type {(e: WheelEvent) => void} */
		this.onWheel = (e) => this.wheel(e)

		let dom = host.surface
		dom.style.touchAction = "none"
		dom.addEventListener("pointerdown", this.onDown)
		dom.addEventListener("pointermove", this.onMove)
		dom.addEventListener("pointerup", this.onUp)
		dom.addEventListener("pointercancel", this.onCancel)
		dom.addEventListener("wheel", this.onWheel, {passive: false})
	}

	/**
	 * Advance the fling to the current time. Position is a function of
	 * time, so a slow frame never shortens a fling.
	 * @param {number} time
	 */
	step(time) {
		if (!this.flingY && !this.flingX) return
		let t = time - this.flingStart
		if (this.flingY) {
			if (t >= this.flingY.duration) {
				this.scrollTop = this.flingY.start + this.flingY.distance
				this.flingY = null
			} else {
				this.scrollTop = axisPos(this.flingY, t)
			}
		}
		if (this.flingX) {
			if (t >= this.flingX.duration) {
				this.scrollLeft = this.flingX.start + this.flingX.distance
				this.flingX = null
			} else {
				this.scrollLeft = axisPos(this.flingX, t)
			}
		}
		this.clamp()
		this.host.requestFrame()
	}

	/**
	 * @param {PointerEvent} e
	 */
	pointerDown(e) {
		if (e.pointerType === "mouse") return
		if (this.pointerId != -1) return
		this.pointerId = e.pointerId
		this.startX = this.lastX = e.clientX
		this.startY = this.lastY = e.clientY
		this.dragging = false
		this.lockX = this.lockY = false
		this.vx.reset()
		this.vy.reset()
		this.host.surface.setPointerCapture(e.pointerId)
	}

	/**
	 * @param {PointerEvent} e
	 */
	pointerMove(e) {
		if (e.pointerId != this.pointerId) return
		let dx = e.clientX - this.lastX, dy = e.clientY - this.lastY
		if (!this.dragging) {
			if (Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP) return
			this.dragging = true
			this.lockX = Math.abs(dx) > Math.abs(dy)
			this.lockY = !this.lockX
			this.stopFling()
		}
		this.lastX = e.clientX
		this.lastY = e.clientY
		this.vx.add(e.timeStamp, this.scrollLeft)
		this.vy.add(e.timeStamp, this.scrollTop)
		if (this.lockY) this.scrollTop -= dy
		if (this.lockX) this.scrollLeft -= dx
		this.clamp()
		this.host.noteInput(e.timeStamp)
		this.host.requestFrame()
		// Flywheel: a touch on a running fling keeps it going.
		if (this.flingY && this.flywheelTimer == null) {
			this.flywheel = true
			this.flywheelTimer = setTimeout(() => {
				this.flywheelTimer = null
				this.flywheel = false
			}, FLYWHEEL_CHECK)
		}
	}

	/**
	 * @param {PointerEvent} e
	 */
	pointerUp(e) {
		if (e.pointerId != this.pointerId) return
		this.pointerId = -1
		this.dragging = false
		this.host.surface.releasePointerCapture(e.pointerId)
		let vy = this.vy.velocity(e.timeStamp)
		let vx = this.vx.velocity(e.timeStamp)
		this.startFling(vy, vx)
	}

	/**
	 * @param {PointerEvent} e
	 */
	pointerCancel(e) {
		if (e.pointerId != this.pointerId) return
		this.pointerId = -1
		this.dragging = false
		try { this.host.surface.releasePointerCapture(e.pointerId) } catch {}
		this.stopFling()
	}

	/**
	 * @param {WheelEvent} e
	 */
	wheel(e) {
		e.preventDefault()
		let unit = 1 / this.host.dpr
		let dx = e.deltaX * unit, dy = e.deltaY * unit
		if (e.shiftKey && !dx) {
			dx = dy
			dy = 0
		}
		this.stopFling()
		this.scrollTop += dy
		this.scrollLeft += dx
		this.clamp()
		this.host.noteInput(e.timeStamp)
		this.host.requestFrame()
		if (this.wheelTimer != null) clearTimeout(this.wheelTimer)
		this.wheelTimer = setTimeout(() => {
			this.wheelTimer = null
		}, 150)
	}

	/**
	 * Stop any running fling.
	 */
	stopFling() {
		if (this.flingY) this.accumulatedY += this.flingY.distance * splinePosition((performance.now() - this.flingStart) / this.flingY.duration) - (this.scrollTop - this.flingY.start)
		if (this.flingX) this.accumulatedX += this.flingX.distance * splinePosition((performance.now() - this.flingStart) / this.flingX.duration) - (this.scrollLeft - this.flingX.start)
		this.flingY = this.flingX = null
		this.flingStart = 0
		this.stoppedFling = true
	}

	/**
	 * Start a fling with the given velocities.
	 * @param {number} vy
	 * @param {number} vx
	 */
	startFling(vy, vx) {
		let dpr = this.host.dpr
		let fy = computeFling(-vy * this.host.scrollSpeed, dpr)
		let fx = computeFling(-vx * this.host.scrollSpeed, dpr)
		// Flywheel: add to the accumulated fling if both are fast enough.
		if (this.flywheel && Math.abs(vy) > MIN_BOOST && Math.abs(fy.distance) > MIN_BOOST) {
			this.accumulatedY += fy.distance
		}
		if (this.flywheel && Math.abs(vx) > MIN_BOOST && Math.abs(fx.distance) > MIN_BOOST) {
			this.accumulatedX += fx.distance
		}
		// Cap accumulated flings.
		let maxAccum = MAX_BOOST * MAX_FLING * dpr
		if (Math.abs(this.accumulatedY) > maxAccum) this.accumulatedY = Math.sign(this.accumulatedY) * maxAccum
		if (Math.abs(this.accumulatedX) > maxAccum) this.accumulatedX = Math.sign(this.accumulatedX) * maxAccum

		if (Math.abs(fy.distance) > 1 || Math.abs(this.accumulatedY) > 1) {
			let dist = fy.distance + this.accumulatedY
			let dur = fy.duration
			// Scale duration if we're boosting.
			if (this.flywheel && Math.abs(dist) > Math.abs(fy.distance)) {
				dur *= Math.abs(dist) / Math.abs(fy.distance)
			}
			this.flingY = {start: this.scrollTop, distance: dist, duration: dur}
			this.accumulatedY = 0
		}
		if (Math.abs(fx.distance) > 1 || Math.abs(this.accumulatedX) > 1) {
			let dist = fx.distance + this.accumulatedX
			let dur = fx.duration
			if (this.flywheel && Math.abs(dist) > Math.abs(fx.distance)) {
				dur *= Math.abs(dist) / Math.abs(fx.distance)
			}
			this.flingX = {start: this.scrollLeft, distance: dist, duration: dur}
			this.accumulatedX = 0
		}
		if (this.flingY || this.flingX) {
			this.flingStart = performance.now()
			this.stoppedFling = false
			this.host.requestFrame()
		}
	}

	/**
	 * Clamp scroll position to valid range.
	 */
	clamp() {
		this.scrollTop = Math.max(0, Math.min(this.host.maxScrollTop, this.scrollTop))
		this.scrollLeft = Math.max(0, Math.min(this.host.maxScrollLeft, this.scrollLeft))
	}

	/**
	 * Whether a fling is currently running.
	 * @returns {boolean}
	 */
	get flinging() {
		return this.flingY != null || this.flingX != null
	}

	destroy() {
		if (this.flywheelTimer != null) clearTimeout(this.flywheelTimer)
		if (this.wheelTimer != null) clearTimeout(this.wheelTimer)
		let dom = this.host.surface
		dom.removeEventListener("pointerdown", this.onDown)
		dom.removeEventListener("pointermove", this.onMove)
		dom.removeEventListener("pointerup", this.onUp)
		dom.removeEventListener("pointercancel", this.onCancel)
		dom.removeEventListener("wheel", this.onWheel)
	}
}
